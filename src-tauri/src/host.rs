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
use tauri::{AppHandle, Manager};

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
// A freshly ready host must stay up this long before its crash/restart streak
// is forgiven. Rapid ready→exit loops (crash or exit 51) inside this window
// therefore accumulate toward the storm cap instead of resetting forever.
const STABLE_WINDOW: Duration = Duration::from_secs(30);

/// Tunable crash/restart storm policy.
///
/// Production defaults (`StormPolicy::default()`):
/// - `stable_window`: 30s — a host that reaches Ready must stay up this long
///   before its crash/restart streak is forgiven;
/// - `initial_backoff` / `max_backoff`: 500ms .. 8s — exponential backoff
///   between respawn attempts inside a storm;
/// - `max_failures`: 8 — after this many windowed exits the supervisor parks
///   in `Failed` until an explicit Start/Restart.
///
/// Tests may construct a HostState with a compressed policy (short window,
/// small backoff, lower cap) so the storm paths are exercised without
/// multi-second sleeps. This is a configuration surface, not a test-only
/// backdoor: operators could tune the same values later.
#[derive(Clone, Copy, Debug)]
struct StormPolicy {
    stable_window: Duration,
    initial_backoff: Duration,
    max_backoff: Duration,
    max_failures: u32,
}

impl Default for StormPolicy {
    fn default() -> Self {
        Self {
            stable_window: STABLE_WINDOW,
            initial_backoff: INITIAL_BACKOFF,
            max_backoff: MAX_BACKOFF,
            max_failures: MAX_SPAWN_FAILURES,
        }
    }
}

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
    /// When the current generation reached Ready; used to decide whether an
    /// exit happened inside the stable window (streak not forgiven) or after
    /// it (streak forgiven). Cleared on adopt, set on promote_ready.
    ready_at: Option<Instant>,
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
            ready_at: None,
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
    storm: StormPolicy,
}

impl Default for HostState {
    fn default() -> Self {
        Self::with_storm_policy(StormPolicy::default())
    }
}

impl HostState {
    /// Build a state with a custom storm policy. Production uses the default;
    /// tests compress the window/backoff/cap so storm paths run quickly.
    fn with_storm_policy(storm: StormPolicy) -> Self {
        let (command_tx, rx) = channel();
        let mut inner = HostInner::default();
        inner.backoff = storm.initial_backoff;
        Self {
            inner: Mutex::new(inner),
            command_tx,
            command_rx: Mutex::new(Some(rx)),
            storm,
        }
    }

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
                    inner.backoff = self.storm.initial_backoff;
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
        inner.backoff = self.storm.initial_backoff;
        inner.lifecycle.attempt = 0;
        inner.lifecycle.next_retry_ms = None;
    }

    /// The current generation reached Ready and has run for at least the
    /// stable window, so its next exit is treated as a fresh incident rather
    /// than part of a storm.
    fn exited_stably(&self) -> bool {
        let inner = self.inner.lock().expect("host");
        match inner.ready_at {
            Some(since) => since.elapsed() >= self.storm.stable_window,
            // No ready this generation (e.g. spawn failure): never stable.
            None => false,
        }
    }

    /// Account for a child exit on the supervisor thread.
    ///
    /// - Exits after the stable window forgive the previous streak first
    ///   (crash restarts counting from one; a cooperative exit-51 restart is
    ///   a legitimate request and does not count at all).
    /// - Exits inside the window (crash *or* exit 51) accumulate the streak,
    ///   so rapid ready→exit loops hit the storm cap instead of looping
    ///   forever.
    ///
    /// Returns true when the caller must back off before respawning.
    fn note_exit(&self, is_restart_request: bool) -> bool {
        let stable = self.exited_stably();
        let mut inner = self.inner.lock().expect("host");
        if stable {
            inner.fail_streak = 0;
            inner.backoff = self.storm.initial_backoff;
        }
        if is_restart_request {
            if stable {
                // Legitimate cooperative reload after stable runtime: the
                // host asked to restart; relaunch immediately, no penalty.
                inner.lifecycle.attempt = 0;
                inner.lifecycle.next_retry_ms = None;
                return false;
            }
            // Restart storm inside the window is treated like a crash loop.
            inner.fail_streak = inner.fail_streak.saturating_add(1);
            inner.lifecycle.attempt = inner.fail_streak;
            return true;
        }
        inner.fail_streak = inner.fail_streak.saturating_add(1);
        inner.lifecycle.attempt = inner.fail_streak;
        true
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
        inner.backoff = inner.backoff.saturating_mul(2).min(self.storm.max_backoff);
        inner.lifecycle.next_retry_ms = Some(inner.backoff.as_millis() as u64);
    }

    fn streak_capped(&self) -> bool {
        let inner = self.inner.lock().expect("host");
        inner.fail_streak >= self.storm.max_failures
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
        inner.ready_at = None;
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
        inner.ready_at = Some(Instant::now());
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
        if state.wants_running() && !state.streak_capped() {
            run_running_segment(state, app, &mut on_ready, &rx);
        } else {
            // Stopped, AppExit, or a capped storm (persistent Failed): park
            // until an explicit Start/Restart command resets the streak.
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
                eprintln!(
                    "[shell] host ready port={} token_len={}",
                    ready.port,
                    ready.token.len()
                );
                on_ready(ready);
                match watch_until_exit(state, rx) {
                    WatchOutcome::Stopped => return,
                    WatchOutcome::Crashed(status) => {
                        // A crash inside the stable window keeps accumulating;
                        // after the window the streak is forgiven first.
                        let needs_backoff = state.note_exit(false);
                        eprintln!(
                            "[shell] host crashed {status:?} ({}/{}, window={:?}), backing off {:?}",
                            state.fail_streak(),
                            state.storm.max_failures,
                            state.storm.stable_window,
                            state.backoff()
                        );
                        if state.streak_capped() {
                            eprintln!("[shell] host restart storm cap reached, giving up");
                            state.mark_failed();
                            return;
                        }
                        if needs_backoff && sleep_or_stop(state, rx) {
                            return;
                        }
                        state.double_backoff();
                    }
                    WatchOutcome::RestartRequested => {
                        // Exit 51 is the host asking for a cooperative restart.
                        // Inside the stable window it is a restart storm and
                        // counts/backs off like a crash; after the window it is
                        // a legitimate request and relaunches immediately.
                        let needs_backoff = state.note_exit(true);
                        eprintln!(
                            "[shell] host requested restart ({HOST_RESTART_EXIT}) streak={}, backoff={:?}",
                            state.fail_streak(),
                            state.backoff()
                        );
                        if state.streak_capped() {
                            eprintln!("[shell] host restart storm cap reached, giving up");
                            state.mark_failed();
                            return;
                        }
                        if needs_backoff && sleep_or_stop(state, rx) {
                            return;
                        }
                        if needs_backoff {
                            state.double_backoff();
                        }
                    }
                }
            }
            Err(err) => {
                if !state.wants_running() {
                    return;
                }
                // Spawn failures never reached Ready, so there is no stable
                // window to forgive them: they always accumulate.
                state.bump_streak();
                eprintln!(
                    "[shell] host spawn failed: {err} ({}/{})",
                    state.fail_streak(),
                    state.storm.max_failures
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
    let launch = resolve_host_launch(app)?;

    let mut cmd = Command::new(&launch.program);
    cmd.args(&launch.args)
        .current_dir(&launch.cwd)
        .env("VRCXK_SHELL", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    let mut tree = ProcessTree::spawn(&mut cmd).map_err(|err| {
        format!(
            "spawn {} in {}: {err}",
            launch.program.display(),
            launch.cwd.display()
        )
    })?;

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

/// A resolved host launch specification (compiled sidecar or dev source).
#[derive(Debug)]
struct HostLaunch {
    program: PathBuf,
    args: Vec<String>,
    cwd: PathBuf,
}

impl HostLaunch {
    fn source() -> Result<Self, String> {
        let bun = find_bun();
        let host_dir = host_dir();
        if !host_dir.join("src/index.ts").is_file() {
            return Err(format!("host entry missing at {}", host_dir.display()));
        }
        Ok(Self {
            program: bun,
            args: vec!["src/index.ts".into()],
            cwd: host_dir,
        })
    }

    fn compiled(program: PathBuf, cwd: PathBuf) -> Self {
        Self {
            program,
            args: vec![],
            cwd,
        }
    }
}

/// Tauri strips the target-triple suffix from external binaries inside the
/// bundle: `host-x86_64-pc-windows-msvc.exe` ships as `host.exe` next to the
/// main executable on Windows (no suffix on Unix).
fn packaged_host_name() -> &'static str {
    if cfg!(windows) {
        "host.exe"
    } else {
        "host"
    }
}

/// Current host Rust target triple with the sidecar file suffix, e.g.
/// `host-x86_64-pc-windows-msvc.exe`. tauri-build injects the exact triple
/// (`TAURI_ENV_TARGET_TRIPLE`) at compile time.
fn host_triple_suffixed_name() -> String {
    let triple = env!("TAURI_ENV_TARGET_TRIPLE");
    let exe = if cfg!(windows) { ".exe" } else { "" };
    format!("host-{triple}{exe}")
}

/// Probe a directory for a usable compiled host binary: first the bundled
/// name (`host[.exe]`, triple suffix stripped), then a dev-placed sidecar
/// named with the host triple. Exposed for tests with fake directories.
fn find_packaged_host(resource_dir: &Path) -> Option<PathBuf> {
    let bundled = resource_dir.join(packaged_host_name());
    if bundled.is_file() {
        return Some(bundled);
    }
    let dev_sidecar = resource_dir.join(host_triple_suffixed_name());
    if dev_sidecar.is_file() {
        return Some(dev_sidecar);
    }
    None
}

/// Resolve how to launch the host.
///
/// Priority (highest first):
/// 1. `VRCXK_HOST_BIN`: explicit compiled binary override; fails fast when
///    the file does not exist (no silent fallback — debugging/tests).
/// 2. Packaged: when an `AppHandle` is available and `resource_dir()` holds
///    the bundled sidecar (`host[.exe]`, triple suffix stripped by Tauri),
///    run it with the resource dir as cwd so the host finds its runtime
///    files (`cordis.yml`, `plugins/`) beside itself. If the resource dir
///    only holds a dev-placed `host-<triple>[.exe]`, use that too.
/// 3. Dev source: current default for `cargo tauri dev`/tests — `bun` +
///    `src/index.ts` in the checked-out `host/` dir (VRCXK_BUN /
///    VRCXK_HOST_DIR overrides kept).
fn resolve_host_launch(app: Option<&AppHandle>) -> Result<HostLaunch, String> {
    let explicit = std::env::var("VRCXK_HOST_BIN").ok().map(PathBuf::from);
    let cwd_override = std::env::var_os("VRCXK_HOST_DIR").map(PathBuf::from);
    resolve_host_launch_with(app, explicit, cwd_override)
}

/// Pure core of `resolve_host_launch` (env values passed in for testability).
fn resolve_host_launch_with(
    app: Option<&AppHandle>,
    explicit: Option<PathBuf>,
    cwd_override: Option<PathBuf>,
) -> Result<HostLaunch, String> {
    // 1. Explicit compiled override (fail fast).
    if let Some(program) = explicit {
        if !program.is_file() {
            return Err(format!(
                "VRCXK_HOST_BIN set but not a file: {}",
                program.display()
            ));
        }
        // Runtime files (cordis.yml/plugins) resolve via cwd. Default to the
        // binary's directory (packaged layout); the dir override (from
        // VRCXK_HOST_DIR) redirects debug runs to a tree holding the runtime
        // files, but only when that directory actually exists.
        let cwd = cwd_override.filter(|p| p.is_dir()).unwrap_or_else(|| {
            program
                .parent()
                .map(|p| p.to_path_buf())
                .unwrap_or_else(|| PathBuf::from("."))
        });
        return Ok(HostLaunch::compiled(program, cwd));
    }

    // 2. Packaged sidecar next to the app resources.
    if let Some(app) = app {
        let Ok(resource_dir) = app.path().resource_dir() else {
            return Err("cannot resolve Tauri resource dir".into());
        };
        if let Some(program) = find_packaged_host(&resource_dir) {
            return Ok(HostLaunch::compiled(program, resource_dir));
        }
    }

    // 3. Dev source (default).
    HostLaunch::source()
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

    // --- stable-window storm accounting ------------------------------------

    fn storm_state(window: Duration, cap: u32) -> HostState {
        HostState::with_storm_policy(StormPolicy {
            stable_window: window,
            initial_backoff: Duration::from_millis(10),
            max_backoff: Duration::from_millis(40),
            max_failures: cap,
        })
    }

    fn force_ready_at(state: &HostState, when: Instant) {
        let mut inner = state.inner.lock().expect("host");
        inner.ready_at = Some(when);
    }

    #[test]
    fn note_exit_forgives_streak_only_after_stable_window() {
        let state = HostState::default();
        let window = state.storm.stable_window;
        let long_ago = Instant::now() - window - Duration::from_secs(1);

        // Inside the window: crash bumps, exit 51 bumps.
        force_ready_at(&state, Instant::now());
        assert!(state.note_exit(false), "crash inside window backs off");
        assert_eq!(state.fail_streak(), 1);
        assert!(state.note_exit(true), "51 inside window backs off");
        assert_eq!(state.fail_streak(), 2);

        // After the window: crash forgives then bumps to one.
        force_ready_at(&state, long_ago);
        assert!(state.note_exit(false), "crash after window backs off");
        assert_eq!(
            state.fail_streak(),
            1,
            "window crash restarts the count at 1"
        );

        // After the window: exit 51 is legitimate, forgiven, no backoff.
        force_ready_at(&state, long_ago);
        assert!(!state.note_exit(true), "51 after window must not back off");
        assert_eq!(state.fail_streak(), 0, "legitimate 51 stays forgiven");
    }

    #[test]
    fn crash_inside_stable_window_accumulates_streak() {
        // Two rapid kills must reach attempt=2: ready no longer forgives the
        // streak, so the supervisor notices the crash loop.
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
            state.force_kill_running();
            let _second = rx
                .recv_timeout(Duration::from_secs(10))
                .expect("second ready");
            state.force_kill_running();
            // Second kill lands inside the stable window (default 30s), so
            // the streak must have accumulated rather than reset at ready.
            let deadline = Instant::now() + Duration::from_secs(10);
            while Instant::now() < deadline {
                let snapshot = state.lifecycle_snapshot();
                if snapshot.attempt >= 2 {
                    break;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            assert!(
                state.lifecycle_snapshot().attempt >= 2,
                "rapid crashes inside the stable window must accumulate; attempt={}",
                state.lifecycle_snapshot().attempt
            );
            state.latch_app_exit();
        });
    }

    #[test]
    fn exit_51_loop_inside_stable_window_reaches_failed_cap_and_start_recovers() {
        // A host that asks to restart (51) faster than the stable window is a
        // restart storm: it must hit the cap and park in Failed instead of
        // looping forever, and an explicit Start must recover it.
        let state = storm_state(Duration::from_secs(5), 3);
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::scope(|scope| {
            scope.spawn(|| {
                supervise_loop(&state, None, |ready| {
                    let _ = tx.send(ready);
                });
            });
            // Fire reload three times; the third 51 must cap the storm.
            for i in 0..3 {
                let ready = rx
                    .recv_timeout(Duration::from_secs(15))
                    .unwrap_or_else(|_| panic!("ready #{i} before cap"));
                assert!(matches!(
                    state.dispatch(HostCommand::Reload),
                    HostCommandResult::Accepted { .. }
                ));
                let _ = ready;
            }
            // After the capped reload, the supervisor must NOT produce a new
            // ready: it parks in Failed waiting for an explicit command.
            std::thread::sleep(Duration::from_millis(400));
            assert!(
                rx.try_recv().is_err(),
                "restart storm must cap into Failed, not keep relaunching"
            );
            assert_eq!(
                state.lifecycle_snapshot().phase,
                HostLifecycleState::Failed,
                "restart storm must end in Failed"
            );
            // A manual Start is the user intent that resets the streak.
            assert!(matches!(
                state.dispatch(HostCommand::Start),
                HostCommandResult::Accepted { .. }
            ));
            let recovered = rx
                .recv_timeout(Duration::from_secs(15))
                .expect("ready after manual start from Failed");
            assert!(recovered.port > 0);
            state.latch_app_exit();
        });
    }

    #[test]
    fn exit_51_after_stable_window_relaunches_without_penalty() {
        // A reload after stable runtime is a legitimate host restart request:
        // no streak accumulation, no backoff, immediate relaunch.
        let state = storm_state(Duration::from_millis(400), 3);
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
            // Wait out the stable window before asking for a restart.
            std::thread::sleep(Duration::from_millis(700));
            assert!(matches!(
                state.dispatch(HostCommand::Reload),
                HostCommandResult::Accepted { .. }
            ));
            let second = rx
                .recv_timeout(Duration::from_secs(15))
                .expect("second ready after stable reload");
            assert_ne!(first.token, second.token);
            assert_eq!(
                state.lifecycle_snapshot().attempt,
                0,
                "a legitimate 51 after the stable window must not count"
            );
            let pid = state.child_id().expect("pid");
            state.dispatch(HostCommand::ForceKill);
            let deadline = Instant::now() + Duration::from_secs(10);
            while Instant::now() < deadline && pid_alive(pid) {
                std::thread::sleep(Duration::from_millis(50));
            }
            assert!(!pid_alive(pid));
            state.latch_app_exit();
        });
    }

    #[test]
    fn crash_after_stable_window_restarts_counting_from_one() {
        // A crash after stable runtime forgives the old streak, then counts
        // the fresh incident as attempt 1 (and still relaunches).
        let state = storm_state(Duration::from_millis(400), 3);
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
            std::thread::sleep(Duration::from_millis(700));
            state.force_kill_running();
            let second = rx
                .recv_timeout(Duration::from_secs(15))
                .expect("second ready after stable crash");
            assert_ne!(first.token, second.token);
            assert_eq!(
                state.lifecycle_snapshot().attempt,
                1,
                "crash after the stable window restarts the count at 1"
            );
            let pid = state.child_id().expect("pid");
            state.dispatch(HostCommand::ForceKill);
            let deadline = Instant::now() + Duration::from_secs(10);
            while Instant::now() < deadline && pid_alive(pid) {
                std::thread::sleep(Duration::from_millis(50));
            }
            assert!(!pid_alive(pid));
            state.latch_app_exit();
        });
    }

    // --- host launch resolver ---------------------------------------------

    /// A throwaway directory with the given file names created inside.
    fn fake_resource_dir(names: &[&str]) -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "vrcxk-resolver-test-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        for name in names {
            std::fs::write(dir.join(name), b"fake host binary").unwrap();
        }
        dir
    }

    #[test]
    fn find_packaged_host_prefers_bundled_name_then_dev_sidecar() {
        let triple_name = host_triple_suffixed_name();
        // Only the dev-placed sidecar (host-<triple>.exe) exists.
        let dir = fake_resource_dir(&[triple_name.as_str()]);
        let found = find_packaged_host(&dir).expect("dev sidecar found");
        assert_eq!(found.file_name().unwrap(), triple_name.as_str());
        // Both exist: the bundled name wins (Tauri-stripped host.exe).
        let dir2 = fake_resource_dir(&[triple_name.as_str(), packaged_host_name()]);
        let found2 = find_packaged_host(&dir2).expect("bundled found");
        assert_eq!(found2.file_name().unwrap(), packaged_host_name());
        // Nothing present: None.
        let dir3 = fake_resource_dir(&[]);
        assert!(find_packaged_host(&dir3).is_none());
        let _ = (dir, dir2, dir3);
    }

    #[test]
    fn resolve_host_launch_uses_explicit_bin_with_fail_fast() {
        // Present override -> compiled launch rooted at its parent dir.
        let dir = fake_resource_dir(&["custom-host.exe"]);
        let launch = resolve_host_launch_with(None, Some(dir.join("custom-host.exe")), None)
            .expect("explicit bin resolves");
        assert_eq!(launch.program, dir.join("custom-host.exe"));
        assert_eq!(launch.cwd, dir);
        assert!(launch.args.is_empty());

        // Missing override -> fast error, no silent fallback.
        let err = resolve_host_launch_with(None, Some(dir.join("nope.exe")), None)
            .expect_err("missing bin must fail");
        assert!(err.contains("VRCXK_HOST_BIN"), "{err}");
        let _ = dir;
    }

    #[test]
    fn resolve_host_launch_honors_cwd_override_only_when_it_exists() {
        let bin_dir = fake_resource_dir(&["custom-host.exe"]);
        let runtime_dir = fake_resource_dir(&["cordis.yml"]);
        let program = bin_dir.join("custom-host.exe");

        // Existing runtime dir override wins over the binary's directory.
        let launch =
            resolve_host_launch_with(None, Some(program.clone()), Some(runtime_dir.clone()))
                .expect("resolves");
        assert_eq!(launch.cwd, runtime_dir);

        // A non-existent override is ignored (falls back to bin dir).
        let missing = runtime_dir.join("does-not-exist");
        let launch =
            resolve_host_launch_with(None, Some(program.clone()), Some(missing)).expect("resolves");
        assert_eq!(launch.cwd, bin_dir);
        let _ = (bin_dir, runtime_dir);
    }

    #[test]
    fn resolve_host_launch_defaults_to_dev_source_without_app() {
        // No override and no AppHandle -> dev source launch (bun).
        // Requires the checked-out host/ tree (same precondition as the
        // existing spawn tests).
        let launch = resolve_host_launch_with(None, None, None).expect("dev source resolves");
        assert!(!launch.args.is_empty(), "source launch runs src/index.ts");
        assert_eq!(launch.args[0], "src/index.ts");
        assert!(launch.cwd.join("src/index.ts").is_file());
    }

    // --- remaining supervisor branch coverage ------------------------------

    #[test]
    fn note_exit_window_boundary_is_inclusive() {
        // Just inside the window (elapsed < window) -> counts; just outside
        // (elapsed >= window) -> forgiven. Exercises the >= boundary exactly.
        let state = storm_state(Duration::from_millis(100), 8);
        // 99ms elapsed of a 100ms window: inside -> 51 counts.
        force_ready_at(&state, Instant::now() - Duration::from_millis(99));
        assert!(state.note_exit(true), "inside window counts and backs off");
        assert_eq!(state.fail_streak(), 1);
        // 100ms elapsed == window: outside -> forgiven, no count.
        force_ready_at(&state, Instant::now() - Duration::from_millis(100));
        assert!(!state.note_exit(true), "at window edge 51 is legitimate");
        assert_eq!(state.fail_streak(), 0);
    }

    #[test]
    fn host_reload_without_peer_records_last_error() {
        // Reload executed when no Ready host/peer exists must not panic and
        // must surface the failure on the snapshot.
        let state = HostState::default();
        state.host_reload();
        let snapshot = state.lifecycle_snapshot();
        assert!(
            snapshot
                .last_error
                .as_deref()
                .unwrap_or("")
                .contains("reload requested without a ready host"),
            "unexpected last_error: {:?}",
            snapshot.last_error
        );
    }
}
