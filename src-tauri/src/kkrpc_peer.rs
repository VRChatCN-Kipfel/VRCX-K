//! Minimal kkrpc **compact-protocol** peer, over an **injected transport**.
//!
//! Why this exists at all (D1 finding, M1-4): the published `kkrpc` Rust crate
//! 0.6.1 speaks the JSON-mode protocol (`{method,args,type,version:"json"}`),
//! which does **not** interoperate with npm kkrpc 2.1.0's compact protocol
//! (`{t:"q",op,p,a}`) — a Rust `Client` against our host simply hung. This is
//! our own ~200-line endpoint implementing the compact frames the host already
//! speaks, so both ends are on one protocol.
//!
//! # The transport is a parameter, not a dependency
//!
//! The peer does not care *how* bytes travel. It is constructed from a
//! `Write` (outbound) and given a `Read` (inbound), so the same protocol, the
//! same pending-request table and the same dispatch logic serve:
//!
//!   - `stdio` — the current M1-4 brain⇄hands bridge. The shell owns the host
//!     as a child process, so a pipe is available and is the cheapest channel.
//!   - any future channel — e.g. a socket to a host that is **not** a local
//!     child (the "brain lives on the desktop, phone is a client" direction in
//!     `docs/mobile-feasibility.md`). That direction has no `ChildStdin` to
//!     hand over, which is exactly the seam this abstraction leaves open.
//!
//! Keeping the abstraction here rather than at the call sites means the frames,
//! the id spaces (`r-` requests, `n-` notifications) and the EOF policy stay in
//! one place: a second transport must not become a second protocol
//! implementation.
//!
//! # Framing
//!
//! One JSON object per line, newline-terminated, in both directions.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// kkrpc wraps callback-style arguments in a value envelope; the host expects
/// the inner value, not the envelope (official interop rule).
const ARG_ENVELOPE: &str = "__kkrpc_next_arg__";

/// Error handed to every in-flight call when the transport ends.
///
/// Wire-visible: it is the `Err` text of any call outstanding at disconnect, so
/// it flows into host-lifecycle diagnostics and the dev smoke panel. Spelled as
/// it was before the transport abstraction existed, so this change does not move
/// a user-visible string.
const TRANSPORT_CLOSED: &str = "host stdio closed";

pub type Handler = Arc<dyn Fn(Vec<Value>) -> Value + Send + Sync>;

pub struct Peer {
    writer: Mutex<Box<dyn Write + Send>>,
    pending: Mutex<HashMap<String, Sender<Result<Value, String>>>>,
    handlers: Mutex<HashMap<String, Handler>>,
}

impl Peer {
    /// Create a peer over a transport. The reader half is installed separately
    /// by [`Peer::start_reader`] so mandatory handlers (e.g. the `ready`
    /// handshake) can be registered first — early frames then stay buffered in
    /// the transport rather than being dispatched as unknown methods.
    pub fn new(writer: impl Write + Send + 'static) -> Arc<Self> {
        Arc::new(Self {
            writer: Mutex::new(Box::new(writer)),
            pending: Mutex::new(HashMap::new()),
            handlers: Mutex::new(HashMap::new()),
        })
    }

    /// Spawn the read loop over the transport's inbound half.
    ///
    /// Takes any `Read`, not a `ChildStdout`: the loop owns the reader for the
    /// lifetime of the thread and only ever calls `read_line`, so a pipe, a
    /// socket and an in-memory buffer are equally valid.
    pub fn start_reader<R: Read + Send + 'static>(self: &Arc<Self>, reader: R) {
        let reader_peer = Arc::clone(self);
        thread::spawn(move || {
            let mut reader = BufReader::new(reader);
            loop {
                let mut line = String::new();
                match reader.read_line(&mut line) {
                    Ok(0) | Err(_) => {
                        // The other end is gone. Fail every waiter now rather
                        // than letting each hit its own timeout: the
                        // distinction between "slow" and "closed" is what the
                        // supervisor acts on.
                        let mut pending = reader_peer.pending.lock().expect("pending");
                        for (_, sender) in pending.drain() {
                            let _ = sender.send(Err(TRANSPORT_CLOSED.into()));
                        }
                        break;
                    }
                    Ok(_) => {}
                }
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                // A malformed line is skipped, not fatal: one bad frame must not
                // take down every later request on the same transport.
                let Ok(message) = serde_json::from_str::<Value>(trimmed) else {
                    continue;
                };
                reader_peer.dispatch(message);
            }
        });
    }

    pub fn on(&self, method: &str, handler: Handler) {
        self.handlers
            .lock()
            .expect("handlers")
            .insert(method.to_string(), handler);
    }

    pub fn call(&self, method: &str, args: Vec<Value>) -> Result<Value, String> {
        self.call_timeout(method, args, Duration::from_secs(10))
    }

    /// Fire-and-forget request: write the same `call` frame but do not register
    /// a pending waiter. The host executes the method and its `r` reply is
    /// ignored (`dispatch` drops responses without a pending sender).
    ///
    /// Used by the supervisor thread for signals whose outcome is observed
    /// through the child process itself (e.g. `restart`, which makes the host
    /// tear down and exit 51) — blocking the single supervisor thread on a 28s
    /// RPC would stall command servicing and child reaping.
    pub fn notify(&self, method: &str, args: Vec<Value>) -> Result<(), String> {
        let id = format!("n-{}", NEXT_ID.fetch_add(1, Ordering::Relaxed));
        self.write(&Self::request_frame(&id, method, args))
    }

    fn request_frame(id: &str, method: &str, args: Vec<Value>) -> Value {
        let path: Vec<Value> = method
            .split('.')
            .map(|segment| Value::String(segment.to_string()))
            .collect();
        let mut payload = serde_json::Map::new();
        payload.insert("t".into(), json!("q"));
        payload.insert("id".into(), json!(id));
        payload.insert("op".into(), json!("call"));
        payload.insert("p".into(), Value::Array(path));
        if !args.is_empty() {
            payload.insert("a".into(), Value::Array(args));
        }
        Value::Object(payload)
    }

    pub fn call_timeout(
        &self,
        method: &str,
        args: Vec<Value>,
        timeout: Duration,
    ) -> Result<Value, String> {
        let id = format!("r-{}", NEXT_ID.fetch_add(1, Ordering::Relaxed));
        let (tx, rx) = mpsc::channel();
        self.pending.lock().expect("pending").insert(id.clone(), tx);
        if let Err(err) = self.write(&Self::request_frame(&id, method, args)) {
            self.pending.lock().expect("pending").remove(&id);
            return Err(err);
        }
        let result = rx.recv_timeout(timeout).map_err(|err| err.to_string());
        self.pending.lock().expect("pending").remove(&id);
        result?
    }

    fn dispatch(self: &Arc<Self>, message: Value) {
        match message.get("t").and_then(Value::as_str) {
            Some("q") if message.get("op").and_then(Value::as_str) == Some("call") => {
                let id = message.get("id").cloned().unwrap_or(json!(""));
                let method = message
                    .get("p")
                    .and_then(Value::as_array)
                    .map(|path| {
                        path.iter()
                            .filter_map(Value::as_str)
                            .collect::<Vec<_>>()
                            .join(".")
                    })
                    .unwrap_or_default();
                let args = message
                    .get("a")
                    .and_then(Value::as_array)
                    .map(|values| values.iter().map(unwrap_arg).collect())
                    .unwrap_or_default();
                let handler = self
                    .handlers
                    .lock()
                    .expect("handlers")
                    .get(&method)
                    .cloned();
                let response = match handler {
                    Some(call) => json!({ "t": "r", "id": id, "v": call(args) }),
                    // Naming the method matters: this text reaches the host and
                    // localises a typo immediately.
                    None => json!({
                        "t": "r",
                        "id": id,
                        "e": { "m": format!("unknown RPC method: {method}") },
                    }),
                };
                let _ = self.write(&response);
            }
            Some("r") => {
                let Some(id) = message.get("id").and_then(Value::as_str) else {
                    return;
                };
                let sender = self.pending.lock().expect("pending").remove(id);
                if let Some(sender) = sender {
                    if let Some(error) = message.get("e") {
                        let text = error
                            .get("m")
                            .and_then(Value::as_str)
                            .unwrap_or("RPC error")
                            .to_string();
                        let _ = sender.send(Err(text));
                    } else {
                        let _ = sender.send(Ok(message.get("v").cloned().unwrap_or(Value::Null)));
                    }
                }
            }
            // Host → shell notifications (`t:"cb"`) are consumed by the
            // registrations in `shell_sys`. Anything else is ignored rather than
            // treated as an error, so a newer host cannot break an older shell
            // merely by sending a frame type it does not know.
            _ => {}
        }
    }

    fn write(&self, message: &Value) -> Result<(), String> {
        let mut encoded = serde_json::to_string(message).map_err(|err| err.to_string())?;
        encoded.push('\n');
        let mut writer = self.writer.lock().map_err(|err| err.to_string())?;
        writer
            .write_all(encoded.as_bytes())
            .map_err(|err| err.to_string())?;
        writer.flush().map_err(|err| err.to_string())
    }
}

fn unwrap_arg(value: &Value) -> Value {
    if value.get(ARG_ENVELOPE).and_then(Value::as_str) == Some("value") {
        value.get("v").cloned().unwrap_or(Value::Null)
    } else {
        value.clone()
    }
}

/// Protocol- and transport-level tests.
///
/// These drive the peer over an **in-memory transport** rather than a real child
/// process. That is the point of the abstraction: framing, id routing and EOF
/// handling do not depend on stdio, so the tests must not either. A
/// child-process test would exercise the OS pipe as much as the protocol and
/// could not reach split or merged frames at all. The real stdio path keeps its
/// own end-to-end coverage in `host`'s sidecar tests.
#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap as StdHashMap;
    use std::io::{self, Cursor, Read, Write};
    use std::sync::mpsc::{channel, Receiver, Sender};
    use std::time::Instant;

    /// Inbound half: the harness pushes byte chunks, the peer reads them.
    /// Dropping the sender is EOF, which is how a closed transport behaves.
    struct ChannelReader {
        rx: Receiver<Vec<u8>>,
        buf: Vec<u8>,
        pos: usize,
    }

    impl Read for ChannelReader {
        fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
            while self.pos >= self.buf.len() {
                match self.rx.recv() {
                    Ok(chunk) => {
                        self.buf = chunk;
                        self.pos = 0;
                    }
                    Err(_) => return Ok(0),
                }
            }
            let n = (self.buf.len() - self.pos).min(out.len());
            out[..n].copy_from_slice(&self.buf[self.pos..self.pos + n]);
            self.pos += n;
            Ok(n)
        }
    }

    /// Outbound half: whatever the peer writes lands in a channel the harness
    /// drains frame by frame.
    struct ChannelWriter {
        tx: Sender<Vec<u8>>,
    }

    impl Write for ChannelWriter {
        fn write(&mut self, data: &[u8]) -> io::Result<usize> {
            self.tx
                .send(data.to_vec())
                .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "harness gone"))?;
            Ok(data.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    struct Harness {
        peer: Arc<Peer>,
        out_rx: Receiver<Vec<u8>>,
        in_tx: Option<Sender<Vec<u8>>>,
        /// Bytes of a frame that has been read but not yet newline-terminated.
        leftover: Vec<u8>,
    }

    impl Harness {
        fn new() -> Self {
            let (out_tx, out_rx) = channel();
            let (in_tx, in_rx) = channel();
            let peer = Peer::new(ChannelWriter { tx: out_tx });
            peer.start_reader(ChannelReader {
                rx: in_rx,
                buf: Vec::new(),
                pos: 0,
            });
            Self {
                peer,
                out_rx,
                in_tx: Some(in_tx),
                leftover: Vec::new(),
            }
        }

        /// Send raw bytes to the peer (other-side → peer direction).
        fn feed(&self, text: &str) {
            self.in_tx
                .as_ref()
                .expect("inbound still open")
                .send(text.as_bytes().to_vec())
                .expect("feed");
        }

        /// Close the inbound direction, which the peer observes as EOF.
        fn close_inbound(&mut self) {
            self.in_tx = None;
        }

        /// Read exactly one protocol frame written by the peer.
        fn next_frame(&mut self) -> Value {
            loop {
                if let Some(end) = self.leftover.iter().position(|byte| *byte == b'\n') {
                    let text = String::from_utf8(self.leftover[..end].to_vec()).expect("utf8");
                    self.leftover.drain(..=end);
                    return serde_json::from_str(&text).expect("a JSON frame");
                }
                let chunk = self
                    .out_rx
                    .recv_timeout(Duration::from_secs(5))
                    .expect("peer wrote a frame");
                self.leftover.extend_from_slice(&chunk);
            }
        }
    }

    fn reply(id: &str, value: Value) -> String {
        format!("{}\n", json!({ "t": "r", "id": id, "v": value }))
    }

    fn error_reply(id: &str, message: &str) -> String {
        format!("{}\n", json!({ "t": "r", "id": id, "e": { "m": message } }))
    }

    // --- outbound framing (the contract with the TS side) -----------------

    #[test]
    fn outbound_frames_use_the_compact_shape() {
        let mut h = Harness::new();
        h.peer
            .notify("shell.notify", vec![json!("title"), json!("body")])
            .expect("write");
        let frame = h.next_frame();

        assert_eq!(frame["t"], json!("q"));
        assert_eq!(frame["op"], json!("call"));
        // The path is an array of segments, not a dotted string.
        assert_eq!(frame["p"], json!(["shell", "notify"]));
        assert_eq!(frame["a"], json!(["title", "body"]));
        assert!(frame["id"].as_str().is_some_and(|id| id.starts_with("n-")));
    }

    #[test]
    fn an_empty_argument_list_is_omitted_from_the_frame() {
        // `a` is present only when there are arguments. Pinned because it is a
        // wire detail the host's parser sees, not an implementation choice.
        let mut h = Harness::new();
        h.peer.notify("ping", Vec::new()).expect("write");
        let frame = h.next_frame();
        assert!(
            frame.get("a").is_none(),
            "empty args must not emit `a`: {frame}"
        );
        assert_eq!(frame["p"], json!(["ping"]));
    }

    #[test]
    fn calls_and_notifications_use_separate_id_spaces() {
        let mut h = Harness::new();
        h.peer.notify("ping", Vec::new()).expect("write");
        let notification = h.next_frame();
        assert!(
            notification["id"].as_str().unwrap().starts_with("n-"),
            "notify must not occupy the request id space: {notification}"
        );

        let peer = Arc::clone(&h.peer);
        let handle = thread::spawn(move || peer.call("ping", Vec::new()));
        let request = h.next_frame();
        let id = request["id"].as_str().unwrap().to_string();
        assert!(
            id.starts_with("r-"),
            "call must use the request space: {id}"
        );
        assert_ne!(id, notification["id"].as_str().unwrap());
        h.feed(&reply(&id, json!("pong")));
        assert_eq!(handle.join().unwrap().unwrap(), json!("pong"));
    }

    // --- request/reply routing --------------------------------------------

    #[test]
    fn a_reply_resolves_the_matching_call() {
        let mut h = Harness::new();
        let peer = Arc::clone(&h.peer);
        let handle = thread::spawn(move || peer.call("ping", Vec::new()));

        let id = h.next_frame()["id"].as_str().unwrap().to_string();
        h.feed(&reply(&id, json!("pong")));
        assert_eq!(handle.join().unwrap().unwrap(), json!("pong"));
        assert!(h.peer.pending.lock().unwrap().is_empty());
    }

    #[test]
    fn an_error_reply_becomes_a_call_error() {
        let mut h = Harness::new();
        let peer = Arc::clone(&h.peer);
        let handle = thread::spawn(move || peer.call("ping", Vec::new()));

        let id = h.next_frame()["id"].as_str().unwrap().to_string();
        h.feed(&error_reply(&id, "boom"));
        assert_eq!(handle.join().unwrap().unwrap_err(), "boom");
        assert!(h.peer.pending.lock().unwrap().is_empty());
    }

    #[test]
    fn concurrent_calls_resolve_against_their_own_replies_out_of_order() {
        let mut h = Harness::new();
        let one = {
            let peer = Arc::clone(&h.peer);
            thread::spawn(move || peer.call("one", Vec::new()))
        };
        let two = {
            let peer = Arc::clone(&h.peer);
            thread::spawn(move || peer.call("two", Vec::new()))
        };

        // Map by method, not arrival order: the two threads race.
        let mut ids: StdHashMap<String, String> = StdHashMap::new();
        for _ in 0..2 {
            let frame = h.next_frame();
            let method = frame["p"][0].as_str().unwrap().to_string();
            ids.insert(method, frame["id"].as_str().unwrap().to_string());
        }
        assert_eq!(ids.len(), 2, "distinct ids for distinct calls: {ids:?}");

        // Answer in the reverse order of the requests to prove keying, not FIFO.
        h.feed(&reply(&ids["two"], json!("second")));
        h.feed(&reply(&ids["one"], json!("first")));

        assert_eq!(one.join().unwrap().unwrap(), json!("first"));
        assert_eq!(two.join().unwrap().unwrap(), json!("second"));
    }

    #[test]
    fn a_call_times_out_when_no_reply_arrives() {
        let h = Harness::new();
        let err = h
            .peer
            .call_timeout("ping", Vec::new(), Duration::from_millis(50))
            .unwrap_err();
        assert!(err.contains("timed out"), "unexpected timeout text: {err}");
    }

    #[test]
    fn notify_never_registers_a_waiter() {
        let mut h = Harness::new();
        h.peer
            .notify("shell.window.show", Vec::new())
            .expect("write");
        let id = h.next_frame()["id"].as_str().unwrap().to_string();
        assert!(
            h.peer.pending.lock().unwrap().is_empty(),
            "a notification must not create a pending entry"
        );

        // Its reply is dropped, and dropping it must not disturb later traffic.
        h.feed(&reply(&id, json!(true)));
        h.peer.on("ping", Arc::new(|_| json!("still-alive")));
        let peer = Arc::clone(&h.peer);
        let handle = thread::spawn(move || peer.call("ping", Vec::new()));
        let next = h.next_frame()["id"].as_str().unwrap().to_string();
        h.feed(&reply(&next, json!("still-alive")));
        assert_eq!(handle.join().unwrap().unwrap(), json!("still-alive"));
    }

    // --- inbound dispatch --------------------------------------------------

    #[test]
    fn a_handler_receives_the_caller_arguments() {
        let mut h = Harness::new();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        h.peer.on(
            "probe",
            Arc::new(move |args| {
                *sink.lock().unwrap() = args;
                json!("ok")
            }),
        );

        h.feed("{\"t\":\"q\",\"id\":\"c1\",\"op\":\"call\",\"p\":[\"probe\"],\"a\":[\"x\",1]}\n");
        let frame = h.next_frame();
        assert_eq!(frame["id"], json!("c1"));
        assert_eq!(frame["v"], json!("ok"));
        assert_eq!(*seen.lock().unwrap(), vec![json!("x"), json!(1)]);
    }

    #[test]
    fn a_value_envelope_argument_is_unwrapped_before_the_handler_sees_it() {
        // kkrpc wraps callback-style arguments; the host expects the inner value
        // (official interop rule). A handler seeing the envelope would silently
        // mis-read every callback payload.
        let mut h = Harness::new();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        h.peer.on(
            "probe",
            Arc::new(move |args| {
                *sink.lock().unwrap() = args;
                Value::Null
            }),
        );

        h.feed(
            "{\"t\":\"q\",\"id\":\"c2\",\"op\":\"call\",\"p\":[\"probe\"],\
             \"a\":[{\"__kkrpc_next_arg__\":\"value\",\"v\":42},{\"plain\":1}]}\n",
        );
        h.next_frame();
        assert_eq!(
            *seen.lock().unwrap(),
            vec![json!(42), json!({ "plain": 1 })],
            "envelope unwrapped, plain object untouched"
        );
    }

    #[test]
    fn an_unknown_method_replies_with_an_error_naming_it() {
        let mut h = Harness::new();
        h.feed("{\"t\":\"q\",\"id\":\"c3\",\"op\":\"call\",\"p\":[\"shell\",\"nope\"]}\n");
        let frame = h.next_frame();
        assert_eq!(frame["id"], json!("c3"));
        assert_eq!(frame["e"]["m"], json!("unknown RPC method: shell.nope"));
        assert!(frame.get("v").is_none(), "an error reply carries no value");
    }

    #[test]
    fn a_method_with_no_arguments_is_dispatched_with_an_empty_list() {
        let mut h = Harness::new();
        let count = Arc::new(Mutex::new(None));
        let sink = Arc::clone(&count);
        h.peer.on(
            "probe",
            Arc::new(move |args| {
                *sink.lock().unwrap() = Some(args.len());
                Value::Null
            }),
        );
        h.feed("{\"t\":\"q\",\"id\":\"c4\",\"op\":\"call\",\"p\":[\"probe\"]}\n");
        h.next_frame();
        assert_eq!(*count.lock().unwrap(), Some(0));
    }

    // --- framing robustness ------------------------------------------------

    #[test]
    fn a_frame_split_across_reads_is_reassembled() {
        let mut h = Harness::new();
        h.peer.on("probe", Arc::new(|_| json!("ok")));
        h.feed("{\"t\":\"q\",\"id\":\"s1\",\"op\":\"call\",");
        h.feed("\"p\":[\"probe\"]}\n");
        assert_eq!(h.next_frame()["id"], json!("s1"));
    }

    #[test]
    fn several_frames_arriving_in_one_chunk_are_all_dispatched() {
        let mut h = Harness::new();
        h.peer.on(
            "probe",
            Arc::new(|args| json!(args.first().cloned().unwrap_or(Value::Null))),
        );
        h.feed(
            "{\"t\":\"q\",\"id\":\"m1\",\"op\":\"call\",\"p\":[\"probe\"],\"a\":[1]}\n\
             {\"t\":\"q\",\"id\":\"m2\",\"op\":\"call\",\"p\":[\"probe\"],\"a\":[2]}\n",
        );
        let first = h.next_frame();
        let second = h.next_frame();
        assert_eq!(
            (first["id"].clone(), first["v"].clone()),
            (json!("m1"), json!(1))
        );
        assert_eq!(
            (second["id"].clone(), second["v"].clone()),
            (json!("m2"), json!(2))
        );
    }

    #[test]
    fn malformed_and_blank_lines_are_skipped_without_killing_the_reader() {
        let mut h = Harness::new();
        h.peer.on("probe", Arc::new(|_| json!("ok")));
        h.feed("this is not json\n");
        h.feed("\n");
        h.feed("{\"t\":\"q\",\"id\":\"k1\",\"op\":\"call\",\"p\":[\"probe\"]}\n");
        // Reaching the reply at all proves the loop survived both bad lines.
        assert_eq!(h.next_frame()["id"], json!("k1"));
    }

    #[test]
    fn an_unrecognised_frame_type_is_ignored() {
        // Forward compatibility: a newer host may send frame types this shell
        // does not know. That must not be an error and must not stop the loop.
        let mut h = Harness::new();
        h.peer.on("probe", Arc::new(|_| json!("ok")));
        h.feed("{\"t\":\"future\",\"whatever\":1}\n");
        h.feed("{\"t\":\"r\",\"id\":\"no-such-request\",\"v\":1}\n");
        h.feed("{\"t\":\"q\",\"id\":\"f1\",\"op\":\"call\",\"p\":[\"probe\"]}\n");
        assert_eq!(h.next_frame()["id"], json!("f1"));
    }

    // --- disconnect policy -------------------------------------------------

    #[test]
    fn a_pending_call_fails_when_the_transport_reaches_eof() {
        let mut h = Harness::new();
        let peer = Arc::clone(&h.peer);
        let handle = thread::spawn(move || peer.call("ping", Vec::new()));

        h.next_frame(); // the request is on the wire, so a waiter exists
        assert_eq!(h.peer.pending.lock().unwrap().len(), 1);
        h.close_inbound();

        assert_eq!(handle.join().unwrap().unwrap_err(), TRANSPORT_CLOSED);
        assert!(
            h.peer.pending.lock().unwrap().is_empty(),
            "EOF must drain every waiter, not leak them into their timeouts"
        );
    }

    #[test]
    fn a_call_after_the_transport_closed_fails_instead_of_hanging() {
        let mut h = Harness::new();
        h.close_inbound();
        // Give the reader thread a moment to observe EOF.
        let deadline = Instant::now() + Duration::from_millis(500);
        while Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        let err = h
            .peer
            .call_timeout("ping", Vec::new(), Duration::from_millis(200))
            .unwrap_err();
        assert!(
            err.contains("timed out") || err == TRANSPORT_CLOSED,
            "a call on a dead transport must fail, not hang: {err}"
        );
    }

    // --- transport independence -------------------------------------------

    #[test]
    fn the_peer_runs_over_a_non_channel_transport() {
        // A shared buffer plus a cursor: nothing pipe-, channel- or
        // process-shaped. This is the actual claim of the abstraction — that
        // framing and dispatch do not depend on stdio — stated without the test
        // harness's own transports.
        struct SharedSink(Arc<Mutex<Vec<u8>>>);
        impl Write for SharedSink {
            fn write(&mut self, data: &[u8]) -> io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(data);
                Ok(data.len())
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }

        let sink = Arc::new(Mutex::new(Vec::<u8>::new()));
        let peer = Peer::new(SharedSink(Arc::clone(&sink)));
        peer.on("probe", Arc::new(|_| json!("ok")));
        peer.start_reader(Cursor::new(
            b"{\"t\":\"q\",\"id\":\"n1\",\"op\":\"call\",\"p\":[\"probe\"]}\n".to_vec(),
        ));

        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let text = String::from_utf8(sink.lock().unwrap().clone()).expect("utf8");
            if let Some(line) = text.lines().next() {
                let frame: Value = serde_json::from_str(line).expect("a JSON frame");
                assert_eq!(frame["id"], json!("n1"));
                assert_eq!(frame["v"], json!("ok"));
                return;
            }
            assert!(
                Instant::now() < deadline,
                "no reply written over the non-channel transport"
            );
            thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn a_writer_failure_is_reported_as_a_call_error() {
        // The transport can refuse writes (a closed socket, a dead pipe). That
        // must surface as an error on the call, and must not leak a pending
        // entry that would only clear on timeout.
        struct BrokenWriter;
        impl Write for BrokenWriter {
            fn write(&mut self, _data: &[u8]) -> io::Result<usize> {
                Err(io::Error::new(io::ErrorKind::BrokenPipe, "closed"))
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }

        let peer = Peer::new(BrokenWriter);
        let err = peer
            .call_timeout("ping", Vec::new(), Duration::from_millis(50))
            .unwrap_err();
        assert!(
            err.contains("closed"),
            "write failure must be reported: {err}"
        );
        assert!(
            peer.pending.lock().unwrap().is_empty(),
            "a failed write must not leave a waiter behind"
        );
    }

    // --- framing edge cases ------------------------------------------------

    #[test]
    fn a_reply_without_a_value_resolves_to_null() {
        let mut h = Harness::new();
        let peer = Arc::clone(&h.peer);
        let handle = thread::spawn(move || peer.call("ping", Vec::new()));
        let id = h.next_frame()["id"].as_str().unwrap().to_string();
        h.feed(&format!("{}\n", json!({ "t": "r", "id": id })));
        assert_eq!(handle.join().unwrap().unwrap(), Value::Null);
    }

    #[test]
    fn an_error_reply_without_a_message_falls_back_to_a_generic_text() {
        let mut h = Harness::new();
        let peer = Arc::clone(&h.peer);
        let handle = thread::spawn(move || peer.call("ping", Vec::new()));
        let id = h.next_frame()["id"].as_str().unwrap().to_string();
        h.feed(&format!("{}\n", json!({ "t": "r", "id": id, "e": {} })));
        assert_eq!(handle.join().unwrap().unwrap_err(), "RPC error");
    }

    #[test]
    fn a_reply_carrying_no_id_is_ignored() {
        let mut h = Harness::new();
        h.peer.on("probe", Arc::new(|_| json!("ok")));
        h.feed("{\"t\":\"r\",\"v\":1}\n");
        h.feed("{\"t\":\"q\",\"id\":\"g1\",\"op\":\"call\",\"p\":[\"probe\"]}\n");
        assert_eq!(h.next_frame()["id"], json!("g1"));
    }
}
