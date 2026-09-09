use crate::host_lifecycle::{
    reduce_command, HostCommand, HostCommandResult, HostLifecycleFacade, HostLifecycleState,
    HostSnapshot,
};
use crate::kkrpc_stdio::Peer;
use crate::process_tree::ProcessTree;
use crate::shell_sys::register_shell_handlers;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
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
}

impl HostInner {
    fn clear(&mut self) {
        self.tree = None;
        self.peer = None;
        self.ready = None;
    }
}

#[derive(Default)]
pub struct HostState {
    inner: Mutex<HostInner>,
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
        }
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

    pub fn dispatch(&self, command: HostCommand) -> HostCommandResult {
        let mut inner = self.inner.lock().expect("host");
        let result = reduce_command(&mut inner.lifecycle, command);
        inner.command_epoch = inner.command_epoch.wrapping_add(1);
        inner.stopping = matches!(
            inner.lifecycle.desired,
            crate::host_lifecycle::HostDesiredState::Stopped
                | crate::host_lifecycle::HostDesiredState::AppExit
        );
        if inner.stopping {
            inner.command_epoch = inner.command_epoch.wrapping_add(1);
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

    pub fn wait_child(&self) -> Option<ExitStatus> {
        loop {
            {
                let mut inner = self.inner.lock().expect("host");
                let tree = inner.tree.as_mut()?;
                match tree.try_wait() {
                    Ok(Some(status)) => {
                        inner.clear();
                        return Some(status);
                    }
                    Ok(None) => {}
                    Err(_) => {
                        inner.clear();
                        return None;
                    }
                }
                if inner.stopping {
                    return None;
                }
            }
            std::thread::sleep(Duration::from_millis(30));
        }
    }

    pub fn latch_stop(&self) {
        let mut inner = self.inner.lock().expect("host");
        inner.stopping = true;
        inner.command_epoch = inner.command_epoch.wrapping_add(1);
        inner.lifecycle.phase = HostLifecycleState::Stopping;
        inner.lifecycle.desired = crate::host_lifecycle::HostDesiredState::Stopped;
    }

    pub fn request_stop(&self) {
        self.request_stop_with_timeout(STOP_TIMEOUT);
    }

    pub fn request_stop_with_timeout(&self, timeout: Duration) {
        // Start one watchdog before writing the RPC. A wedged host must not
        // receive a fresh child-exit wait after consuming the RPC timeout.
        let deadline = Instant::now() + timeout;
        self.latch_stop();
        let peer = self.inner.lock().expect("host").peer.clone();
        if let Some(peer) = peer {
            let _ = peer.call_timeout("stop", vec![], stop_rpc_timeout(deadline));
        }
        while Instant::now() < deadline {
            let mut inner = self.inner.lock().expect("host");
            match inner.tree.as_mut() {
                None => {
                    inner.clear();
                    return;
                }
                Some(tree) => {
                    if let Ok(Some(_)) = tree.try_wait() {
                        inner.clear();
                        return;
                    }
                }
            }
            drop(inner);
            std::thread::sleep(Duration::from_millis(20));
        }
        self.reap_tree();
    }

    #[cfg(test)]
    pub fn force_kill_running(&self) {
        let mut inner = self.inner.lock().expect("host");
        if let Some(tree) = inner.tree.as_mut() {
            tree.kill_tree();
        }
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

enum ExitKind {
    RestartRequested,
    Stopped,
    Crashed(Option<ExitStatus>),
}

fn classify_exit(status: Option<ExitStatus>) -> ExitKind {
    match status {
        Some(status) if status.code() == Some(HOST_RESTART_EXIT) => ExitKind::RestartRequested,
        Some(status) => ExitKind::Crashed(Some(status)),
        None => ExitKind::Stopped,
    }
}

pub fn supervise_loop(
    state: &HostState,
    app: Option<&AppHandle>,
    mut on_ready: impl FnMut(HostReady),
) {
    let mut fail_streak = 0u32;
    let mut backoff = INITIAL_BACKOFF;
    loop {
        if state.is_stopping() {
            break;
        }
        match spawn_host_into(state, app) {
            Ok(ready) => {
                fail_streak = 0;
                backoff = INITIAL_BACKOFF;
                eprintln!(
                    "[shell] host ready port={} token_len={}",
                    ready.port,
                    ready.token.len()
                );
                on_ready(ready);
                let status = state.wait_child();
                if state.is_stopping() {
                    break;
                }
                match classify_exit(status) {
                    ExitKind::RestartRequested => {
                        eprintln!("[shell] host requested restart ({HOST_RESTART_EXIT})");
                    }
                    ExitKind::Stopped => break,
                    ExitKind::Crashed(status) => {
                        fail_streak += 1;
                        eprintln!(
                            "[shell] host crashed {status:?} ({fail_streak}/{MAX_SPAWN_FAILURES}), backing off {backoff:?}"
                        );
                        if fail_streak >= MAX_SPAWN_FAILURES {
                            eprintln!("[shell] host restart storm cap reached, giving up");
                            break;
                        }
                        if sleep_or_stop(state, backoff) {
                            break;
                        }
                        backoff = backoff.saturating_mul(2).min(MAX_BACKOFF);
                    }
                }
            }
            Err(err) => {
                if state.is_stopping() {
                    break;
                }
                fail_streak += 1;
                eprintln!("[shell] host spawn failed: {err} ({fail_streak}/{MAX_SPAWN_FAILURES})");
                if fail_streak >= MAX_SPAWN_FAILURES {
                    eprintln!("[shell] host restart storm cap reached, giving up");
                    break;
                }
                if sleep_or_stop(state, backoff) {
                    break;
                }
                backoff = backoff.saturating_mul(2).min(MAX_BACKOFF);
            }
        }
    }
}

fn sleep_or_stop(state: &HostState, total: Duration) -> bool {
    let deadline = Instant::now() + total;
    while Instant::now() < deadline {
        if state.is_stopping() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    state.is_stopping()
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
        });
    }
}
