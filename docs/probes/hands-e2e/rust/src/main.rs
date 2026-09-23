// The hands e2e binary: the PRODUCTION capability modules over real stdio.
//
// It compiles `src-tauri/src/kkrpc_peer.rs` and `src-tauri/src/hands.rs` directly
// by path — these are the real files, not copies. That is the point: the probe
// tests shipped code, so it cannot drift from it.
//
// Why not run the Tauri app itself: the app needs a webview and a window, so it
// cannot run headless in CI. The capability under test has no Tauri dependency
// (only serde/base64/notify/file-id), so mounting it on a bare stdio loop is
// both possible and strictly more focused — it cannot pass because some
// unrelated part of the app happened to work.

// The `#[path]` is relative to THIS file: src/ → rust/ → hands-e2e/ → probes/ →
// docs/ → repo root.
#[path = "../../../../../src-tauri/src/kkrpc_peer.rs"]
pub mod kkrpc_peer;

#[path = "../../../../../src-tauri/src/hands.rs"]
pub mod hands;

use std::io::Write;
use std::sync::Arc;

fn main() {
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();

    // Handlers must be registered BEFORE the reader starts: an early frame must
    // not be dispatched as an unknown method. This is the same ordering the
    // production path uses (host.rs registers, then starts the reader).
    let peer = kkrpc_peer::Peer::new(stdout);
    hands::register_hands_handlers(&peer);

    // Tell the driver we are listening, so a missing binary or a broken
    // registration is distinguishable from a slow start.
    let mut boot = std::io::stdout();
    let _ = writeln!(boot, "{}", serde_json::json!({ "t": "boot" }));
    let _ = boot.flush();

    peer.start_reader(stdin);

    // The reader thread owns the loop, so park this thread. The process ends
    // when the driver closes stdin and the reader sees EOF.
    loop {
        std::thread::sleep(std::time::Duration::from_secs(3600));
    }
}

// Keep the trait imports honest: the probe only needs the registration entry
// point, so a compile error here means the public surface changed.
#[allow(dead_code)]
fn _surface_is_public(peer: &Arc<kkrpc_peer::Peer>) {
    hands::register_hands_handlers(peer);
}
