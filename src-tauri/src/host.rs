use crate::kkrpc_stdio::Peer;
use crate::process_tree::ProcessTree;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const HOST_RESTART_EXIT: i32 = 51;
const STOP_TIMEOUT: Duration = Duration::from_secs(2);
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

#[derive(Default)]
struct HostInner {
    generation: u64,
    stopping: bool,
    tree: Option<ProcessTree>,
    peer: Option<Arc<Peer>>,
    ready: Option<HostReady>,
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

impl HostState {
    pub fn snapshot(&self) -> Option<HostReady> {
        self.inner.lock().expect("host").ready.clone()
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

    pub fn request_stop(&self) {
        let peer = {
            let mut inner = self.inner.lock().expect("host");
            inner.stopping = true;
            inner.generation = inner.generation.wrapping_add(1);
            inner.peer.clone()
        };
        if let Some(peer) = peer {
            let _ = peer.call_timeout("stop", vec![], Duration::from_millis(1500));
        }
        let deadline = Instant::now() + STOP_TIMEOUT;
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
        Ok(())
    }

    fn promote_ready(&self, generation: u64, ready: HostReady) -> Result<HostReady, ()> {
        let mut inner = self.inner.lock().expect("host");
        if inner.stopping || inner.generation != generation || inner.tree.is_none() {
            return Err(());
        }
        inner.ready = Some(ready.clone());
        Ok(ready)
    }

    fn generation(&self) -> Result<u64, String> {
        let inner = self.inner.lock().expect("host");
        if inner.stopping {
            return Err("stopping".into());
        }
        Ok(inner.generation)
    }

    fn still_current(&self, generation: u64) -> bool {
        let inner = self.inner.lock().expect("host");
        !inner.stopping && inner.generation == generation
    }
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

pub fn supervise_loop(state: &HostState, mut on_ready: impl FnMut(HostReady)) {
    let mut fail_streak = 0u32;
    let mut backoff = INITIAL_BACKOFF;
    loop {
        if state.is_stopping() {
            break;
        }
        match spawn_host_into(state) {
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
    let mut starting = start_host_process()?;
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

fn spawn_host_into(state: &HostState) -> Result<HostReady, String> {
    let generation = state.generation()?;
    let starting = start_host_process()?;
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

fn start_host_process() -> Result<StartingHost, String> {
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
    let peer = Peer::start(stdout, stdin);
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
    let name = bun_exe();
    if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
        let candidate = PathBuf::from(home).join(".bun/bin").join(name);
        if candidate.is_file() {
            return candidate;
        }
    }
    if let Some(found) = find_on_path(name) {
        return found;
    }
    PathBuf::from(name)
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
        assert!(spawn_host_into(&state).is_err());
        assert!(state.child_id().is_none());
    }

    #[test]
    fn kill_host_relaunches_with_new_token() {
        let state = HostState::default();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::scope(|scope| {
            scope.spawn(|| {
                supervise_loop(&state, |ready| {
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
                supervise_loop(&state, |ready| {
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
