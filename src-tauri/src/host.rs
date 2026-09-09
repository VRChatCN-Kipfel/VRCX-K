use crate::host_lifecycle::{
    reduce_command, HostCommand, HostCommandResult, HostDesiredState, HostLifecycleFacade,
    HostLifecycleState, HostSnapshot,
};
use crate::kkrpc_stdio::Peer;
use crate::process_tree::ProcessTree;
use crate::shell_sys::register_shell_handlers;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender, TryRecvError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::AppHandle;

pub const HOST_RESTART_EXIT: i32 = 51;
// A cooperative stop is allowed to take time while the host remains responsive.
// This is also the watchdog budget: it starts when the stop request is sent,
// is shared by the RPC wait and child-exit wait, and ends by killing the process
// tree. A user-initiated force kill takes a separate immediate path.
const STOP_TIMEOUT: Duration = Duration::from_secs(30);
// Leaves a small response-frame margin inside the shared 30s watchdog budget.
const STOP_RPC_TIMEOUT: Duration = Duration::from_secs(28);
const MAX_SPAWN_FAILURES: u32 = 8;
const INITIAL_BACKOFF: Duration = Duration::from_millis(500);
const MAX_BACKOFF: Duration = Duration::from_secs(8);

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HostReady {
    pub port: u16,
    pub token: String,
}

#[cfg(test)]
pub struct HostSession {
    pub tree: ProcessTree,
    pub peer: Arc<Peer>,
    pub ready: HostReady,
}

struct HostInner {
    generation: u64,
    command_epoch: u64,
    stopping: bool,
    tree: Option<ProcessTree>,
    peer: Option<Arc<Peer>>,
    ready: Option<HostReady>,
    lifecycle: HostSnapshot,
    fail_streak: u32,
    backoff: Duration,
}

impl HostInner {
    fn clear(&mut self) {
        self.tree = None;
        self.peer = None;
        self.ready = None;
    }
}

impl Default for HostInner {
    fn default() -> Self {
        Self {
            generation: 0,
            command_epoch: 0,
            stopping: false,
            tree: None,
            peer: None,
            ready: None,
            lifecycle: HostSnapshot::new(),
            fail_streak: 0,
            backoff: INITIAL_BACKOFF,
        }
    }
}

/// Single source of truth for host process state and the command bus that
/// drives the supervisor.
///
/// # Threading model
/// `dispatch()` runs on the caller thread (Tauri IPC, tray router). It never
/// blocks on process I/O: it reduces the command against the public snapshot,
/// fences `stopping`, and enqueues the command on a channel. The dedicated
/// supervisor thread (see `supervise_loop`) is the *only* thread that spawns,
/// stops, force-kills or reloads the host, so commands are serialized and a
/// double-spawn race is impossible by construction. Generation is still
/// allocated only after a real `Command::spawn` succeeds (see
/// `spawn_host_into`); stop/force only advance the internal command epoch.
pub struct HostState {
    inner: Mutex<HostInner>,
    /// Commands accepted by `dispatch` are delivered here. `supervise_loop`
    /// takes the receiver exactly once; senders may be cloned freely.
    command_tx: Sender<HostCommand>,
    command_rx: Mutex<Option<Receiver<HostCommand>>>,
}

impl Default for HostState {
    fn default() -> Self {
        let (command_tx, rx) = channel();
        Self {
            inner: Mutex::new(HostInner::default()),
            command_tx,
            command_rx: Mutex::new(Some(rx)),
        }
    }
}

impl HostState {
    fn take_command_rx(&self) -> Option<Receiver<HostCommand>> {
        self.command_rx.lock().expect("host rx").take()
    }

    fn command_tx(&self) -> Sender<HostCommand> {
        self.command_tx.clone()
    }

    fn wants_running(&self) -> bool {
        let inner = self.inner.lock().expect("host");
        inner.lifecycle.desired == HostDesiredState::Running && !inner.stopping
    }

    fn desired(&self) -> HostDesiredState {
        self.inner.lock().expect("host").lifecycle.desired
    }
}

impl HostLifecycleFacade for HostState {
    fn snapshot(&self) -> HostSnapshot {
        self.lifecycle_snapshot()
    }

    fn dispatch(&self, command: HostCommand) -> HostCommandResult {
        HostState::dispatch(self, command)
    }
}

impl HostState {
    pub fn snapshot(&self) -> Option<HostReady> {
        self.inner.lock().expect("host").ready.clone()
    }

    pub fn lifecycle_snapshot(&self) -> HostSnapshot {
        self.inner.lock().expect("host").lifecycle.clone()
    }

    /// Accept a host lifecycle command and hand it to the supervisor.
    ///
    /// This is the stable entry point used by the Tauri IPC command
    /// (`dispatch_host_command`) and, through the `HostLifecycleFacade`
    /// trait, by the #6 tray router. The returned `HostCommandResult` is the
    /// *synchronous* reducer verdict (Accepted/Noop/Rejected) against the
    /// current snapshot; Accepted additionally fences `stopping` and wakes the
    /// supervisor, which performs the real process orchestration off-thread.
    pub fn dispatch(&self, command: HostCommand) -> HostCommandResult {
        let mut inner = self.inner.lock().expect("host");
        let result = reduce_command(&mut inner.lifecycle, command);
        if matches!(result, HostCommandResult::Accepted { .. }) {
            // Fence the supervisor against the previous intent before the
            // worker observes the command. Only Start/Restart clear stopping;
            // stop/force latch it so the watch loop aborts and cannot relaunch.
            match command {
                HostCommand::Start | HostCommand::Restart => {
                    inner.stopping = false;
                    // A user-intended start resets the crash storm bookkeeping
                    // so a Failed host can recover without a full app restart.
                    inner.fail_streak = 0;
                    inner.backoff = INITIAL_BACKOFF;
                    inner.lifecycle.next_retry_ms = None;
                }
                HostCommand::GracefulStop | HostCommand::ForceKill => inner.stopping = true,
                HostCommand::Reload => {}
            }
            inner.command_epoch = inner.command_epoch.wrapping_add(1);
            if let Err(err) = self.command_tx().send(command) {
                eprintln!("[shell] supervisor unavailable, command dropped: {err:?}");
            }
        }
        result
    }

    pub fn is_stopping(&self) -> bool {
        self.inner.lock().expect("host").stopping
    }

    #[cfg(test)]
    pub fn child_id(&self) -> Option<u32> {
        self.inner
            .lock()
            .expect("host")
            .tree
            .as_ref()
            .map(ProcessTree::id)
    }

    pub fn peer(&self) -> Option<Arc<Peer>> {
        self.inner.lock().expect("host").peer.clone()
    }

    /// True while a host process is adopted (Starting or Ready).
    fn has_child(&self) -> bool {
        self.inner.lock().expect("host").tree.is_some()
    }

    /// Supervisor-only force kill after dispatch latched `Stopped`. Kills and
    /// reaps the whole process tree; the host must not be relaunched.
    fn force_kill_stopped(&self) -> Result<(), String> {
        let mut inner = self.inner.lock().expect("host");
        if inner.tree.is_none() {
            return Ok(());
        }
        inner.peer = None;
        inner.ready = None;
        inner.lifecycle.phase = HostLifecycleState::Stopping;
        inner.lifecycle.last_exit = None;
        let tree = inner.tree.take();
        drop(inner);
        let mut tree = tree.ok_or("host process tree vanished")?;
        tree.kill_tree();
        self.finish_stopped();
        Ok(())
    }

    /// Reset crash/backoff state for a user-intended start or restart.
    fn reset_storm_state(&self) {
        let mut inner = self.inner.lock().expect("host");
        inner.fail_streak = 0;
        inner.backoff = INITIAL_BACKOFF;
        inner.lifecycle.attempt = 0;
        inner.lifecycle.next_retry_ms = None;
    }

    fn record_ready_metrics(&self) {
        let mut inner = self.inner.lock().expect("host");
        inner.fail_streak = 0;
        inner.backoff = INITIAL_BACKOFF;
        inner.lifecycle.attempt = 0;
        inner.lifecycle.next_retry_ms = None;
    }

    fn mark_failed(&self) {
        let mut inner = self.inner.lock().expect("host");
        inner.lifecycle.phase = HostLifecycleState::Failed;
        inner.lifecycle.next_retry_ms = None;
        inner.lifecycle.last_error = Some("host restart storm cap reached".into());
    }

    /// Restore the running intent after a Restart command stopped the current
    /// generation (dispatch already reduced phase=Starting, desired=Running;
    /// the stop helper temporarily latched Stopped/Stopping over it).
    fn resume_running(&self) {
        let mut inner = self.inner.lock().expect("host");
        inner.stopping = false;
        inner.lifecycle.desired = HostDesiredState::Running;
        // dispatch(Restart) reduced phase=Starting; the stop helpers may have
        // overwritten it with Stopping/Stopped, so restore the reduced phase.
        inner.lifecycle.phase = HostLifecycleState::Starting;
    }

    fn bump_streak(&self) {
        let mut inner = self.inner.lock().expect("host");
        inner.fail_streak = inner.fail_streak.saturating_add(1);
        inner.lifecycle.attempt = inner.fail_streak;
    }

    fn double_backoff(&self) {
        let mut inner = self.inner.lock().expect("host");
        inner.backoff = inner.backoff.saturating_mul(2).min(MAX_BACKOFF);
        inner.lifecycle.next_retry_ms = Some(inner.backoff.as_millis() as u64);
    }

    fn streak_capped(&self) -> bool {
        let inner = self.inner.lock().expect("host");
        inner.fail_streak >= MAX_SPAWN_FAILURES
    }

    fn fail_streak(&self) -> u32 {
        self.inner.lock().expect("host").fail_streak
    }

    fn backoff(&self) -> Duration {
        self.inner.lock().expect("host").backoff
    }

    /// Supervisor-only host-cooperative reload: tell a Ready host to tear down
    /// and exit 51. The running segment then spawns the next generation.
    fn host_reload(&self) {
        let Some(peer) = self.peer() else {
            let mut inner = self.inner.lock().expect("host");
            inner.lifecycle.last_error = Some("reload requested without a ready host".into());
            return;
        };
        match peer.call_timeout("restart", vec![], STOP_RPC_TIMEOUT) {
            Ok(_) => {}
            Err(err) => {
                let mut inner = self.inner.lock().expect("host");
                inner.lifecycle.last_error = Some(format!("host reload RPC failed: {err}"));
            }
        }
    }

    /// Latch a terminal desired state (`Stopped`/`AppExit`) and fence the
    /// current command epoch. Process teardown is performed by the caller.
    fn latch_desired(&self, desired: crate::host_lifecycle::HostDesiredState) {
        let mut inner = self.inner.lock().expect("host");
        inner.stopping = true;
        inner.command_epoch = inner.command_epoch.wrapping_add(1);
        inner.lifecycle.phase = HostLifecycleState::Stopping;
        inner.lifecycle.desired = desired;
    }

    pub fn latch_app_exit(&self) {
        self.latch_desired(crate::host_lifecycle::HostDesiredState::AppExit);
    }

    #[cfg(test)]
    pub fn request_stop(&self) {
        self.request_stop_with_timeout(STOP_TIMEOUT);
    }

    pub fn request_app_exit_graceful(&self) {
        self.request_stop_with_desired(
            STOP_TIMEOUT,
            crate::host_lifecycle::HostDesiredState::AppExit,
        );
    }

    /// Cooperative stop of the current host generation: latch `Stopped`, call
    /// the `stop` RPC, wait for child exit within `timeout`, then kill the
    /// process tree if the deadline expires. The host is not relaunched.
    pub fn request_stop_with_timeout(&self, timeout: Duration) {
        self.request_stop_with_desired(timeout, crate::host_lifecycle::HostDesiredState::Stopped);
    }

    fn request_stop_with_desired(
        &self,
        timeout: Duration,
        desired: crate::host_lifecycle::HostDesiredState,
    ) {
        // Start one watchdog before writing the RPC. A wedged host must not
        // receive a fresh child-exit wait after consuming the RPC timeout.
        let deadline = Instant::now() + timeout;
        self.latch_desired(desired);
        let peer = self.inner.lock().expect("host").peer.clone();
        if let Some(peer) = peer {
            let _ = peer.call_timeout("stop", vec![], stop_rpc_timeout(deadline));
        }
        while Instant::now() < deadline {
            let mut inner = self.inner.lock().expect("host");
            match inner.tree.as_mut() {
                None => {
                    inner.clear();
                    drop(inner);
                    self.finish_stopped();
                    return;
                }
                Some(tree) => {
                    if let Ok(Some(_)) = tree.try_wait() {
                        inner.clear();
                        drop(inner);
                        self.finish_stopped();
                        return;
                    }
                }
            }
            drop(inner);
            std::thread::sleep(Duration::from_millis(20));
        }
        self.reap_tree();
        self.finish_stopped();
    }

    /// Record a completed stop in the public snapshot (child already cleared).
    /// The desired state stays whatever the stop latched (Stopped/AppExit).
    fn finish_stopped(&self) {
        let mut inner = self.inner.lock().expect("host");
        inner.lifecycle.phase = HostLifecycleState::Stopped;
        inner.lifecycle.pid = None;
        inner.lifecycle.port = None;
        inner.lifecycle.next_retry_ms = None;
    }

    #[cfg(test)]
    pub fn force_kill_running(&self) {
        let mut inner = self.inner.lock().expect("host");
        if let Some(tree) = inner.tree.as_mut() {
            tree.kill_tree();
        }
    }

    pub fn force_app_exit(&self) {
        self.latch_app_exit();
        self.reap_tree();
    }

    fn reap_tree(&self) {
        let mut tree = {
            let mut inner = self.inner.lock().expect("host");
            inner.peer = None;
            inner.ready = None;
            inner.tree.take()
        };
        if let Some(tree) = tree.as_mut() {
            tree.kill_tree();
        }
    }

    fn adopt_inflight(
        &self,
        generation: u64,
        tree: ProcessTree,
        peer: Arc<Peer>,
    ) -> Result<(), ProcessTree> {
        let mut inner = self.inner.lock().expect("host");
        if inner.stopping || inner.generation != generation {
            return Err(tree);
        }
        inner.tree = Some(tree);
        inner.peer = Some(peer);
        inner.ready = None;
        inner.lifecycle.generation = generation;
        inner.lifecycle.phase = HostLifecycleState::Starting;
        inner.lifecycle.pid = inner.tree.as_ref().map(ProcessTree::id);
        Ok(())
    }

    fn promote_ready(&self, generation: u64, ready: HostReady) -> Result<HostReady, ()> {
        let mut inner = self.inner.lock().expect("host");
        if inner.stopping || inner.generation != generation || inner.tree.is_none() {
            return Err(());
        }
        inner.ready = Some(ready.clone());
        inner.lifecycle.phase = HostLifecycleState::Ready;
        inner.lifecycle.pid = inner.tree.as_ref().map(ProcessTree::id);
        inner.lifecycle.port = Some(ready.port);
        inner.lifecycle.last_error = None;
        Ok(ready)
    }

    fn still_current(&self, generation: u64) -> bool {
        let inner = self.inner.lock().expect("host");
        !inner.stopping && inner.generation == generation
    }
}

fn stop_rpc_timeout(deadline: Instant) -> Duration {
    STOP_RPC_TIMEOUT.min(deadline.saturating_duration_since(Instant::now()))
}

pub fn supervise_loop(
    state: &HostState,
    app: Option<&AppHandle>,
    mut on_ready: impl FnMut(HostReady),
) {
    let Some(rx) = state.take_command_rx() else {
        eprintln!("[shell] supervisor already bound to this HostState");
        return;
    };
    // Initial intent follows the snapshot default (Running): a fresh
    // HostState starts the host automatically, preserving legacy behavior.
    loop {
        if state.desired() == HostDesiredState::AppExit {
            return;
        }
        // Non-blocking drain so a Start arriving while we were deciding does
        // not wait for the next spawn/watch cycle boundary.
        while let Ok(command) = rx.try_recv() {
            if supervise_command(state, command) {
                return;
            }
        }
        if state.wants_running() {
            run_running_segment(state, app, &mut on_ready, &rx);
        } else {
            wait_for_start(state, &rx);
        }
    }
}

/// Block until a Start/Restart arrives (or the app exits). The only commands
/// valid while the host is not running are Start and Restart; the reducer
/// rejects the rest, and Reload only targets a Ready host.
fn wait_for_start(state: &HostState, rx: &Receiver<HostCommand>) {
    loop {
        if state.desired() == HostDesiredState::AppExit {
            return;
        }
        match rx.recv_timeout(Duration::from_millis(250)) {
            Ok(HostCommand::Start | HostCommand::Restart) => return,
            Ok(_) => {
                // Reducer rejected it; ignore stragglers from a racing caller.
            }
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => return,
        }
    }
}

/// Execute a single command from the supervisor thread. Returns `true` when
/// the supervisor must exit (app exit latched while executing a command).
fn supervise_command(state: &HostState, command: HostCommand) -> bool {
    match command {
        HostCommand::Start => {
            // Already fenced in dispatch; just (re)enter the running segment.
            state.reset_storm_state();
        }
        HostCommand::GracefulStop => {
            state.request_stop_with_timeout(STOP_TIMEOUT);
        }
        HostCommand::ForceKill => {
            // The reducer latched Stopped; kill and reap immediately. This is
            // "end the host", not a simulated crash: no automatic relaunch.
            let _ = state.force_kill_stopped();
        }
        HostCommand::Restart => {
            state.reset_storm_state();
            // Stop the current generation first (RPC stop with deadline, then
            // kill tree on timeout), then let the loop respawn: this is the
            // shell-guaranteed restart even if the host wedges.
            if state.has_child() {
                state.request_stop_with_timeout(STOP_TIMEOUT);
            }
            // The stop helper latched Stopped over the reducer's Running
            // intent; restore it so the loop re-enters the running segment.
            state.resume_running();
        }
        HostCommand::Reload => {
            // Host-cooperative full reload: the host tears down and exits 51;
            // the running segment observes RestartRequested and relaunches.
            state.host_reload();
        }
    }
    state.desired() == HostDesiredState::AppExit
}

fn run_running_segment(
    state: &HostState,
    app: Option<&AppHandle>,
    on_ready: &mut impl FnMut(HostReady),
    rx: &Receiver<HostCommand>,
) {
    // Spawn/watch until a stop intent or storm cap ends this running segment.
    // Crash streak and backoff live on HostInner so dispatch-side commands and
    // the running segment observe one source of truth.
    loop {
        // Keep servicing commands even between spawn attempts so e.g. a
        // ForceKill during backoff is honored without waiting out the sleep.
        if let Ok(command) = rx.try_recv() {
            match command {
                HostCommand::GracefulStop => {
                    state.request_stop_with_timeout(STOP_TIMEOUT);
                    return;
                }
                HostCommand::ForceKill => {
                    let _ = state.force_kill_stopped();
                    return;
                }
                HostCommand::Start | HostCommand::Restart => {
                    state.reset_storm_state();
                }
                HostCommand::Reload => state.host_reload(),
            }
        }
        if !state.wants_running() {
            return;
        }
        if state.streak_capped() {
            state.mark_failed();
            return;
        }
        match spawn_host_into(state, app) {
            Ok(ready) => {
                state.record_ready_metrics();
                eprintln!(
                    "[shell] host ready port={} token_len={}",
                    ready.port,
                    ready.token.len()
                );
                on_ready(ready);
                match watch_until_exit(state, rx) {
                    WatchOutcome::Stopped => return,
                    WatchOutcome::Crashed(status) => {
                        state.bump_streak();
                        eprintln!(
                            "[shell] host crashed {status:?} ({}/{MAX_SPAWN_FAILURES}), backing off {:?}",
                            state.fail_streak(),
                            state.backoff()
                        );
                        if state.streak_capped() {
                            eprintln!("[shell] host restart storm cap reached, giving up");
                            state.mark_failed();
                            return;
                        }
                        if sleep_or_stop(state, rx) {
                            return;
                        }
                        state.double_backoff();
                    }
                    WatchOutcome::RestartRequested => {
                        // Host exited 51: cooperative reload/restart. It is not
                        // a crash: the loop immediately spawns the next gen.
                        eprintln!("[shell] host requested restart ({HOST_RESTART_EXIT})");
                    }
                }
            }
            Err(err) => {
                if !state.wants_running() {
                    return;
                }
                state.bump_streak();
                eprintln!(
                    "[shell] host spawn failed: {err} ({}/{MAX_SPAWN_FAILURES})",
                    state.fail_streak()
                );
                if state.streak_capped() {
                    eprintln!("[shell] host restart storm cap reached, giving up");
                    state.mark_failed();
                    return;
                }
                if sleep_or_stop(state, rx) {
                    return;
                }
                state.double_backoff();
            }
        }
    }
}

enum WatchOutcome {
    Stopped,
    RestartRequested,
    Crashed(Option<ExitStatus>),
}

/// Watch the current child until it exits, servicing lifecycle commands as
/// they arrive. Runs on the supervisor thread.
fn watch_until_exit(state: &HostState, rx: &Receiver<HostCommand>) -> WatchOutcome {
    loop {
        // GracefulStop/ForceKill/Reload/Restart may arrive while running.
        match rx.try_recv() {
            Ok(HostCommand::GracefulStop) => {
                state.request_stop_with_timeout(STOP_TIMEOUT);
                return WatchOutcome::Stopped;
            }
            Ok(HostCommand::ForceKill) => {
                let _ = state.force_kill_stopped();
                return WatchOutcome::Stopped;
            }
            Ok(HostCommand::Restart) => {
                state.reset_storm_state();
                if state.has_child() {
                    state.request_stop_with_timeout(STOP_TIMEOUT);
                }
                // Fall through and return Stopped so the running segment loops
                // and spawns the new generation.
                state.resume_running();
                return WatchOutcome::Stopped;
            }
            Ok(HostCommand::Reload) => {
                // Ask the host to tear down and exit 51; watch continues.
                state.host_reload();
            }
            Ok(HostCommand::Start) => {}
            Err(TryRecvError::Empty) => {}
            Err(TryRecvError::Disconnected) => return WatchOutcome::Stopped,
        }
        if state.desired() == HostDesiredState::AppExit {
            return WatchOutcome::Stopped;
        }
        if state.is_stopping() {
            return WatchOutcome::Stopped;
        }
        {
            let mut inner = state.inner.lock().expect("host");
            let Some(tree) = inner.tree.as_mut() else {
                return WatchOutcome::Stopped;
            };
            match tree.try_wait() {
                Ok(Some(status)) => {
                    inner.clear();
                    drop(inner);
                    return classify_watch(Some(status));
                }
                Ok(None) => {}
                Err(_) => {
                    inner.clear();
                    return WatchOutcome::Stopped;
                }
            }
        }
        std::thread::sleep(Duration::from_millis(30));
    }
}

fn classify_watch(status: Option<ExitStatus>) -> WatchOutcome {
    match status {
        Some(status) if status.code() == Some(HOST_RESTART_EXIT) => WatchOutcome::RestartRequested,
        Some(status) => WatchOutcome::Crashed(Some(status)),
        None => WatchOutcome::Stopped,
    }
}

fn sleep_or_stop(state: &HostState, rx: &Receiver<HostCommand>) -> bool {
    let total = state.backoff();
    let deadline = Instant::now() + total;
    while Instant::now() < deadline {
        if !state.wants_running() {
            return true;
        }
        // Keep the snapshot's nextRetryMs honest while backing off.
        {
            let mut inner = state.inner.lock().expect("host");
            let remaining = deadline.saturating_duration_since(Instant::now());
            inner.lifecycle.phase = HostLifecycleState::Backoff;
            inner.lifecycle.next_retry_ms = Some(remaining.as_millis() as u64);
        }
        // A Start/Restart during backoff is honored immediately.
        match rx.try_recv() {
            Ok(HostCommand::Start | HostCommand::Restart) => {
                state.reset_storm_state();
                return false;
            }
            Ok(HostCommand::GracefulStop) => {
                state.request_stop_with_timeout(STOP_TIMEOUT);
                return true;
            }
            Ok(HostCommand::ForceKill) => {
                let _ = state.force_kill_stopped();
                return true;
            }
            Ok(_) => {}
            Err(TryRecvError::Empty) => {}
            Err(TryRecvError::Disconnected) => return true,
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    !state.wants_running()
}

#[cfg(test)]
pub fn spawn_host() -> Result<HostSession, String> {
    let mut starting = start_host_process(None)?;
    let ready = wait_until_ready(&mut starting, || false)?;
    let pong = starting
        .peer
        .call("ping", vec![])
        .map_err(|err| format!("host ping: {err}"))?;
    if pong != serde_json::json!("pong") {
        starting.tree.kill_tree();
        return Err(format!("host ping returned {pong}"));
    }
    Ok(HostSession {
        tree: starting.tree,
        peer: starting.peer,
        ready,
    })
}

fn spawn_host_into(state: &HostState, app: Option<&AppHandle>) -> Result<HostReady, String> {
    {
        let mut inner = state.inner.lock().expect("host");
        if inner.stopping {
            return Err("stopping".into());
        }
        inner.lifecycle.phase = HostLifecycleState::Starting;
        inner.lifecycle.desired = crate::host_lifecycle::HostDesiredState::Running;
    }
    // Allocate the public generation only after the process has spawned and is
    // ready to be adopted; failed Command::spawn must not consume a generation.
    let starting = start_host_process(app)?;
    let generation = {
        let mut inner = state.inner.lock().expect("host");
        let Some(next_generation) = inner.generation.checked_add(1) else {
            drop(inner);
            let mut tree = starting.tree;
            tree.kill_tree();
            return Err("host generation exceeds JSON safe integer range".into());
        };
        if next_generation > crate::host_lifecycle::MAX_SAFE_INTEGER {
            drop(inner);
            let mut tree = starting.tree;
            tree.kill_tree();
            return Err("host generation exceeds JSON safe integer range".into());
        }
        inner.generation = next_generation;
        inner.lifecycle.generation = inner.generation;
        inner.generation
    };
    let peer = starting.peer.clone();
    if let Err(mut tree) = state.adopt_inflight(generation, starting.tree, peer) {
        tree.kill_tree();
        return Err("stopped during spawn".into());
    }
    let wait = wait_until_ready_in_state(state, generation, &starting.ready_slot);
    let ready = match wait {
        Ok(ready) => ready,
        Err(err) => {
            state.reap_tree();
            return Err(err);
        }
    };
    let Some(peer) = state.peer() else {
        state.reap_tree();
        return Err("host peer lost".into());
    };
    let pong = peer
        .call("ping", vec![])
        .map_err(|err| format!("host ping: {err}"))?;
    if pong != serde_json::json!("pong") {
        state.reap_tree();
        return Err(format!("host ping returned {pong}"));
    }
    match state.promote_ready(generation, ready) {
        Ok(ready) => Ok(ready),
        Err(()) => {
            state.reap_tree();
            Err("stopped during ready".into())
        }
    }
}

struct StartingHost {
    tree: ProcessTree,
    peer: Arc<Peer>,
    ready_slot: Arc<Mutex<Option<HostReady>>>,
}

fn start_host_process(app: Option<&AppHandle>) -> Result<StartingHost, String> {
    let bun = find_bun();
    let host_dir = host_dir();
    if !host_dir.join("src/index.ts").is_file() {
        return Err(format!("host entry missing at {}", host_dir.display()));
    }

    let mut cmd = Command::new(&bun);
    cmd.arg("src/index.ts")
        .current_dir(&host_dir)
        .env("VRCXK_SHELL", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    let mut tree = ProcessTree::spawn(&mut cmd)
        .map_err(|err| format!("spawn {} in {}: {err}", bun.display(), host_dir.display()))?;

    let stdout = tree.child_stdout().ok_or("host stdout")?;
    let stdin = tree.child_stdin().ok_or("host stdin")?;
    let peer = Peer::new(stdin);

    // Register the mandatory startup handshake before reading stdout. If the
    // host is already ready, its frame remains safely buffered in the pipe.
    let ready_slot: Arc<Mutex<Option<HostReady>>> = Arc::new(Mutex::new(None));
    let ready_handler = Arc::clone(&ready_slot);
    peer.on(
        "ready",
        Arc::new(move |args| {
            if let Some(info) = args.first() {
                if let (Some(port), Some(token)) = (
                    info.get("port").and_then(|v| v.as_u64()),
                    info.get("token").and_then(|v| v.as_str()),
                ) {
                    *ready_handler.lock().expect("ready slot") = Some(HostReady {
                        port: port as u16,
                        token: token.to_string(),
                    });
                }
            }
            serde_json::Value::Null
        }),
    );
    if let Some(app) = app {
        register_shell_handlers(&peer, app.clone());
    }
    peer.start_reader(stdout);
    Ok(StartingHost {
        tree,
        peer,
        ready_slot,
    })
}

#[cfg(test)]
fn wait_until_ready(
    starting: &mut StartingHost,
    mut abort: impl FnMut() -> bool,
) -> Result<HostReady, String> {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(ready) = starting.ready_slot.lock().expect("ready slot").clone() {
            return Ok(ready);
        }
        if abort() {
            starting.tree.kill_tree();
            return Err("stopped during ready".into());
        }
        if Instant::now() >= deadline {
            starting.tree.kill_tree();
            return Err("host did not call ready() within 10s".into());
        }
        if let Ok(Some(status)) = starting.tree.try_wait() {
            return Err(format!("host exited before ready: {status}"));
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn wait_until_ready_in_state(
    state: &HostState,
    generation: u64,
    ready_slot: &Mutex<Option<HostReady>>,
) -> Result<HostReady, String> {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if !state.still_current(generation) {
            return Err("stopped during ready".into());
        }
        if let Some(ready) = ready_slot.lock().expect("ready slot").clone() {
            return Ok(ready);
        }
        {
            let mut inner = state.inner.lock().expect("host");
            if let Some(tree) = inner.tree.as_mut() {
                if let Ok(Some(status)) = tree.try_wait() {
                    inner.clear();
                    return Err(format!("host exited before ready: {status}"));
                }
            }
        }
        if Instant::now() >= deadline {
            return Err("host did not call ready() within 10s".into());
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn bun_exe() -> &'static str {
    if cfg!(windows) {
        "bun.exe"
    } else {
        "bun"
    }
}

fn find_bun() -> PathBuf {
    if let Ok(explicit) = std::env::var("VRCXK_BUN") {
        return PathBuf::from(explicit);
    }
    // 1. Standalone install (bun.sh default): ~/.bun/bin/bun[.exe]
    let name = bun_exe();
    if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
        let candidate = PathBuf::from(home).join(".bun/bin").join(name);
        if candidate.is_file() {
            return candidate;
        }
    }
    // 2. npm global install: PATH has `bun`/`bun.cmd` shims in the npm prefix
    //    dir, but the real binary lives at <prefix>/node_modules/bun/bin/bun.exe.
    //    Spawning the shim directly fails on Windows (not an executable), so
    //    resolve through the shim directory.
    for shim in ["bun.cmd", "bun.exe", "bun"] {
        if let Some(dir) = shim_dir_on_path(shim) {
            let candidate = dir.join("node_modules/bun/bin").join(name);
            if candidate.is_file() {
                return candidate;
            }
        }
    }
    // 3. Plain `bun.exe` on PATH.
    if let Some(found) = find_on_path(name) {
        return found;
    }
    // 4. Fallback: bare name (hope it is on PATH after all).
    PathBuf::from(name)
}

/// Return the directory containing the first PATH entry named `name`
/// (skipping `.ps1` shims which cannot be spawned directly).
fn shim_dir_on_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).find_map(|dir| {
        let candidate = dir.join(name);
        if !candidate.is_file() {
            return None;
        }
        if candidate.extension().and_then(|ext| ext.to_str()) == Some("ps1") {
            return None;
        }
        Some(dir)
    })
}

fn find_on_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).find_map(|dir| {
        let candidate = dir.join(name);
        if !candidate.is_file() {
            return None;
        }
        if candidate.extension().and_then(|ext| ext.to_str()) == Some("ps1") {
            return None;
        }
        Some(candidate)
    })
}

fn host_dir() -> PathBuf {
    if let Ok(explicit) = std::env::var("VRCXK_HOST_DIR") {
        return PathBuf::from(explicit);
    }
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../host")
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from("../host"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::process_tree::pid_alive;

    #[test]
    fn restart_exit_matches_named_const() {
        assert_eq!(HOST_RESTART_EXIT, 51);
    }

    #[test]
    fn spawn_host_ready_ping_stop() {
        let mut session = spawn_host().expect("spawn host");
        assert!(session.ready.port > 0);
        assert_eq!(session.ready.token.len(), 64);
        let pong = session.peer.call("ping", vec![]).expect("ping");
        assert_eq!(pong, serde_json::json!("pong"));
        let stopped = session.peer.call("stop", vec![]).expect("stop");
        assert_eq!(stopped, serde_json::json!(true));
        let status = session.tree.wait().expect("wait host");
        assert!(status.success(), "{status}");
    }

    #[test]
    fn call_times_out_after_host_dies() {
        let mut session = spawn_host().expect("spawn host");
        let pid = session.tree.id();
        session.tree.kill_tree();
        assert!(!pid_alive(pid));
        let started = Instant::now();
        let err = session
            .peer
            .call_timeout("ping", vec![], Duration::from_secs(2));
        assert!(err.is_err(), "{err:?}");
        assert!(started.elapsed() < Duration::from_secs(4));
    }

    #[test]
    fn stop_rpc_timeout_uses_only_the_watchdog_budget_remaining() {
        let deadline = Instant::now() + Duration::from_millis(30);
        std::thread::sleep(Duration::from_millis(10));
        let timeout = stop_rpc_timeout(deadline);
        assert!(timeout < Duration::from_millis(30));
        assert!(timeout <= STOP_RPC_TIMEOUT);
    }

    #[test]
    fn stop_rpc_timeout_is_zero_after_watchdog_expires() {
        let deadline = Instant::now() - Duration::from_millis(1);
        assert_eq!(stop_rpc_timeout(deadline), Duration::ZERO);
    }

    #[test]
    fn find_bun_uses_platform_exe_name() {
        let name = bun_exe();
        assert_eq!(name.ends_with(".exe"), cfg!(windows));
        assert_ne!(name, "bun.ps1");
        let bun = find_bun();
        assert_ne!(bun.extension().and_then(|ext| ext.to_str()), Some("ps1"));
    }

    #[test]
    fn spawn_into_stopping_state_fails() {
        let state = HostState::default();
        state.request_stop();
        assert!(spawn_host_into(&state, None).is_err());
        assert!(state.child_id().is_none());
    }

    #[test]
    fn kill_host_relaunches_with_new_token() {
        let state = HostState::default();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::scope(|scope| {
            scope.spawn(|| {
                supervise_loop(&state, None, |ready| {
                    let _ = tx.send(ready);
                });
            });
            let first = rx
                .recv_timeout(Duration::from_secs(10))
                .expect("first ready");
            let first_pid = state.child_id().expect("first pid");
            state.force_kill_running();
            let second = rx
                .recv_timeout(Duration::from_secs(10))
                .expect("second ready");
            assert_ne!(first.token, second.token);
            assert_ne!(first.port, second.port);
            let second_pid = state.child_id().expect("second pid");
            state.request_stop();
            assert!(!pid_alive(first_pid));
            assert!(!pid_alive(second_pid));
            // The supervisor only exits on an app-exit latch; end it so the
            // scoped thread can join.
            state.latch_app_exit();
        });
    }

    #[test]
    fn exit_51_relaunches_with_new_token() {
        let state = HostState::default();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::scope(|scope| {
            scope.spawn(|| {
                supervise_loop(&state, None, |ready| {
                    let _ = tx.send(ready);
                });
            });
            let first = rx
                .recv_timeout(Duration::from_secs(10))
                .expect("first ready");
            state
                .peer()
                .expect("peer")
                .call("restart", vec![])
                .expect("restart");
            let second = rx
                .recv_timeout(Duration::from_secs(10))
                .expect("second ready");
            assert_ne!(first.token, second.token);
            let second_pid = state.child_id().expect("second pid");
            state.request_stop();
            assert!(!pid_alive(second_pid));
            state.latch_app_exit();
        });
    }

    // --- dispatch-driven orchestration ------------------------------------

    #[test]
    fn dispatch_graceful_stop_actually_stops_host_and_does_not_relaunch() {
        let state = HostState::default();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::scope(|scope| {
            scope.spawn(|| {
                supervise_loop(&state, None, |ready| {
                    let _ = tx.send(ready);
                });
            });
            let _first = rx
                .recv_timeout(Duration::from_secs(10))
                .expect("first ready");
            let first_pid = state.child_id().expect("first pid");
            // Reducer accepts GracefulStop from Ready.
            assert!(matches!(
                state.dispatch(HostCommand::GracefulStop),
                HostCommandResult::Accepted { .. }
            ));
            // The supervisor performs the real stop: child gone, no relaunch.
            let deadline = Instant::now() + Duration::from_secs(15);
            while Instant::now() < deadline {
                let snapshot = state.lifecycle_snapshot();
                if snapshot.phase == HostLifecycleState::Stopped {
                    break;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            assert!(!pid_alive(first_pid));
            assert_eq!(
                state.lifecycle_snapshot().phase,
                HostLifecycleState::Stopped,
                "graceful stop must settle the snapshot at Stopped"
            );
            // No second ready must arrive while stopped.
            std::thread::sleep(Duration::from_millis(400));
            assert!(rx.try_recv().is_err(), "host must not relaunch after stop");
            state.latch_app_exit();
        });
    }

    #[test]
    fn dispatch_start_after_stop_relaunches_host() {
        let state = HostState::default();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::scope(|scope| {
            scope.spawn(|| {
                supervise_loop(&state, None, |ready| {
                    let _ = tx.send(ready);
                });
            });
            let first = rx
                .recv_timeout(Duration::from_secs(10))
                .expect("first ready");
            let first_pid = state.child_id().expect("first pid");
            // GracefulStop must be accepted from Ready.
            assert!(matches!(
                state.dispatch(HostCommand::GracefulStop),
                HostCommandResult::Accepted { .. }
            ));
            // Wait until the supervisor reports Stopped (child reaped), not
            // merely until the pid is gone: dispatch(Start) is only accepted
            // from Stopped/Failed/Backoff, so racing the snapshot would flake.
            let deadline = Instant::now() + Duration::from_secs(15);
            while Instant::now() < deadline {
                let snapshot = state.lifecycle_snapshot();
                if snapshot.phase == HostLifecycleState::Stopped {
                    break;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            assert_eq!(
                state.lifecycle_snapshot().phase,
                HostLifecycleState::Stopped,
                "graceful stop must settle the snapshot at Stopped"
            );
            assert!(!pid_alive(first_pid));
            // Start again: a new generation must come up.
            assert!(matches!(
                state.dispatch(HostCommand::Start),
                HostCommandResult::Accepted { .. }
            ));
            let second = rx
                .recv_timeout(Duration::from_secs(10))
                .expect("second ready after start");
            assert_ne!(first.token, second.token);
            let second_pid = state.child_id().expect("second pid");
            state.dispatch(HostCommand::ForceKill);
            let deadline = Instant::now() + Duration::from_secs(10);
            while Instant::now() < deadline && pid_alive(second_pid) {
                std::thread::sleep(Duration::from_millis(50));
            }
            assert!(!pid_alive(second_pid));
            state.latch_app_exit();
        });
    }

    #[test]
    fn dispatch_force_kill_stops_without_relaunch() {
        let state = HostState::default();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::scope(|scope| {
            scope.spawn(|| {
                supervise_loop(&state, None, |ready| {
                    let _ = tx.send(ready);
                });
            });
            let _first = rx
                .recv_timeout(Duration::from_secs(10))
                .expect("first ready");
            let first_pid = state.child_id().expect("first pid");
            assert!(matches!(
                state.dispatch(HostCommand::ForceKill),
                HostCommandResult::Accepted { .. }
            ));
            let deadline = Instant::now() + Duration::from_secs(15);
            while Instant::now() < deadline {
                let snapshot = state.lifecycle_snapshot();
                if snapshot.phase == HostLifecycleState::Stopped {
                    break;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            assert!(!pid_alive(first_pid));
            assert_eq!(
                state.lifecycle_snapshot().phase,
                HostLifecycleState::Stopped,
                "force kill must settle the snapshot at Stopped"
            );
            std::thread::sleep(Duration::from_millis(400));
            assert!(rx.try_recv().is_err(), "force kill must not relaunch");
            state.latch_app_exit();
        });
    }

    #[test]
    fn dispatch_restart_while_ready_restarts_host() {
        let state = HostState::default();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::scope(|scope| {
            scope.spawn(|| {
                supervise_loop(&state, None, |ready| {
                    let _ = tx.send(ready);
                });
            });
            let first = rx
                .recv_timeout(Duration::from_secs(10))
                .expect("first ready");
            let first_pid = state.child_id().expect("first pid");
            assert!(matches!(
                state.dispatch(HostCommand::Restart),
                HostCommandResult::Accepted { .. }
            ));
            let second = rx
                .recv_timeout(Duration::from_secs(15))
                .expect("second ready after restart");
            assert_ne!(first.token, second.token);
            let second_pid = state.child_id().expect("second pid");
            assert!(!pid_alive(first_pid));
            state.dispatch(HostCommand::GracefulStop);
            let deadline = Instant::now() + Duration::from_secs(10);
            while Instant::now() < deadline && pid_alive(second_pid) {
                std::thread::sleep(Duration::from_millis(50));
            }
            assert!(!pid_alive(second_pid));
            state.latch_app_exit();
        });
    }

    #[test]
    fn dispatch_reload_while_ready_relaunches_via_exit_51() {
        let state = HostState::default();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::scope(|scope| {
            scope.spawn(|| {
                supervise_loop(&state, None, |ready| {
                    let _ = tx.send(ready);
                });
            });
            let first = rx
                .recv_timeout(Duration::from_secs(10))
                .expect("first ready");
            let first_pid = state.child_id().expect("first pid");
            assert!(matches!(
                state.dispatch(HostCommand::Reload),
                HostCommandResult::Accepted { .. }
            ));
            let second = rx
                .recv_timeout(Duration::from_secs(15))
                .expect("second ready after reload");
            assert_ne!(first.token, second.token);
            let second_pid = state.child_id().expect("second pid");
            assert!(!pid_alive(first_pid));
            state.dispatch(HostCommand::ForceKill);
            let deadline = Instant::now() + Duration::from_secs(10);
            while Instant::now() < deadline && pid_alive(second_pid) {
                std::thread::sleep(Duration::from_millis(50));
            }
            assert!(!pid_alive(second_pid));
            state.latch_app_exit();
        });
    }
}
