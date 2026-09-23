//! The hands' file capability: `hands.stat` / `hands.read` / `hands.write` /
//! `hands.watch`.
//!
//! Scope, stated because it is easy to over-read: this is the **transport and
//! primitive layer** only. It is NOT the plugin-facing SDK — the `ctx.hands`
//! service, its types and its audit hook live on the brain side and are shaped
//! by [`../../docs/hands-capability-proposal.md`]. What lands here is the part
//! the proposal cannot decide on its own: the four primitives, over the wire,
//! with real backpressure and real cancellation.
//!
//! # Why four primitives and not more
//!
//! Measured, not chosen: the per-file cost of a remote round trip is a full RTT
//! (~1 RTT per file; at 5 ms RTT that is 320x slower than batching), so
//! directory walking, batch sizing and retry belong to the caller. The hands
//! answer exactly one question each: *what is this*, *give me bytes*, *take
//! bytes*, *tell me when it changes*. `docs/probes/transport-lab/FINDINGS.md` §6.
//!
//! # Backpressure is not optional
//!
//! `read` and `watch` return kkrpc **stream references**, so the host pulls and
//! memory is `credit × chunk`, not file size. A consumer that stops taking
//! values stops the producer at the credit window (32 by default). The
//! alternative — one reply carrying all the bytes — is the thing that measured
//! as unusable at ≥1 MiB.
//!
//! # Chunking, and the one synchronous-CPU trap
//!
//! Every buffer here is allocated per chunk and bounded by [`CHUNK`]. A single
//! `vec![0; file_size]` is *synchronous* CPU in the caller's thread: measured at
//! ~0.25 s of frozen event loop for 1 GiB. So the rule is structural, not
//! stylistic — there is no code path that allocates a whole file.

use crate::kkrpc_peer::{
    DeferredReply, Peer, StreamProducer, StreamSink, StreamSource, StreamStep,
};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::{json, Value};
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::Arc;
use std::time::{Duration, UNIX_EPOCH};

/// Bytes per stream chunk. Sized to match the probe's proven value and to stay
/// well inside the credit window's memory bound (32 × 256 KiB = 8 MiB).
const CHUNK: usize = 256 * 1024;

/// Register every `hands.*` capability handler on the peer.
pub fn register_hands_handlers(peer: &Arc<Peer>) {
    register_stat(peer);
    register_read(peer);
    register_write(peer);
    register_watch(peer);
}

// --- error surface ---------------------------------------------------------

/// The error codes the proposal fixes. Kept as a closed set because adding a
/// code later is a breaking change for callers that branch on it.
///
/// `ESTALE` is deliberately distinct from `ENOENT`: "the path is now a different
/// file" (reopen and reset the offset) and "the file is gone" (usually give up)
/// need opposite handling, and merging them forces callers to match on message
/// text. See the proposal's §2.2.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Code {
    NotFound,
    Denied,
    IsDir,
    Stale,
    NoSpace,
    Unsupported,
}

impl Code {
    fn as_str(self) -> &'static str {
        match self {
            Code::NotFound => "ENOENT",
            Code::Denied => "EACCES",
            Code::IsDir => "EISDIR",
            Code::Stale => "ESTALE",
            Code::NoSpace => "ENOSPC",
            Code::Unsupported => "EUNSUPPORTED",
        }
    }
}

/// Map an `io::Error` onto the closed code set.
///
/// The code is carried in the error message as a `CODE: detail` prefix rather
/// than as a structured field: kkrpc's error frame only carries `{n,m}` (name,
/// message) — see `dist/channel-*.js`'s `T()` encoder — so an extra property
/// would be dropped on the wire. A prefix survives and stays greppable.
fn encode_error(code: Code, detail: impl std::fmt::Display) -> String {
    format!("{}: {detail}", code.as_str())
}

fn classify(error: &std::io::Error) -> Code {
    match error.kind() {
        std::io::ErrorKind::NotFound => Code::NotFound,
        std::io::ErrorKind::PermissionDenied => Code::Denied,
        std::io::ErrorKind::IsADirectory => Code::IsDir,
        std::io::ErrorKind::StorageFull => Code::NoSpace,
        std::io::ErrorKind::Unsupported => Code::Unsupported,
        // Windows reports a directory handed to `File::open` for writing as
        // "access denied" rather than `IsADirectory`.
        std::io::ErrorKind::Other if error.to_string().contains("os error 5") => Code::Denied,
        _ => Code::Denied,
    }
}

// --- stat ------------------------------------------------------------------

/// `hands.stat(path) -> {size,id,mtimeMs,kind} | null`
///
/// Returns `null` for a missing path instead of throwing: "does not exist" is a
/// normal answer to a question, and forcing callers into try/catch for control
/// flow is how error codes get ignored. A path that exists but cannot be read
/// (permissions) is a real error and does throw — the caller can act on that.
fn register_stat(peer: &Arc<Peer>) {
    peer.on(
        "hands.stat",
        Arc::new(|args| {
            let path = str_arg(&args, 0);
            match stat_path(&path) {
                Ok(stat) => stat,
                Err(error) if classify(&error) == Code::NotFound => Value::Null,
                Err(error) => {
                    // The reply value carries the code; there is no separate
                    // error channel for a `t:"r"` frame, and the caller needs to
                    // branch on the code rather than parse prose.
                    json!({ "error": encode_error(classify(&error), error) })
                }
            }
        }),
    );
}

fn stat_path(path: &str) -> std::io::Result<Value> {
    // `File::open` on a directory succeeds on Unix but not on Windows, so
    // branch on the type first and only open regular files (which is what
    // `file-id` needs).
    let meta = std::fs::metadata(path)?;
    let kind = if meta.is_dir() {
        "dir"
    } else if meta.is_file() {
        "file"
    } else {
        "other"
    };

    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|delta| delta.as_millis() as u64)
        .unwrap_or(0);

    // Identity is best-effort: a filesystem that cannot report one (some
    // network shares) must not turn `stat` into a failure, because size and
    // mtime are still useful. Callers that need rotation detection compare
    // `id` only when it is present.
    let id = file_id::get_file_id(path)
        .ok()
        .map(|id| format!("{id:?}"))
        .unwrap_or_default();

    Ok(json!({
        "size": meta.len(),
        "id": id,
        "mtimeMs": mtime_ms,
        "kind": kind,
    }))
}

// --- read (producer) -------------------------------------------------------

/// Read one file as a stream of chunks, optionally from an offset.
///
/// `offset` is a plain argument rather than a separate `resume` method:
/// `seek(SeekFrom::Start(n))` *is* the resumption mechanism, and inventing a
/// method for it would put a policy decision (when to resume) inside the hands.
fn register_read(peer: &Arc<Peer>) {
    let target = Arc::clone(peer);
    peer.on_deferred(
        "hands.read",
        Arc::new(move |reply: DeferredReply, args: Vec<Value>| {
            let path = str_arg(&args, 0);
            let opts = args.get(1).cloned().unwrap_or_else(|| json!({}));
            let offset = opts.get("offset").and_then(Value::as_u64).unwrap_or(0);

            match FileReader::open(&path, offset) {
                Ok(reader) => {
                    if let Err(error) = target.open_stream(&reply_id(&reply), Box::new(reader)) {
                        reply.fail(error);
                    }
                }
                Err(error) => reply.fail(error),
            }
        }),
    );
}

/// The `id` a [`DeferredReply`] will answer, so [`Peer::open_stream`] can write
/// the stream-ref as that request's reply.
fn reply_id(reply: &DeferredReply) -> String {
    reply.id().to_string()
}

struct FileReader {
    file: File,
    /// Identity captured at open, so a rotation *during* the read is reported
    /// rather than silently splicing two different files together.
    opened_id: String,
    path: PathBuf,
}

impl FileReader {
    fn open(path: &str, offset: u64) -> Result<Self, String> {
        let meta =
            std::fs::metadata(path).map_err(|error| encode_error(classify(&error), error))?;
        if meta.is_dir() {
            return Err(encode_error(Code::IsDir, path));
        }
        let mut file = File::open(path).map_err(|error| encode_error(classify(&error), error))?;
        if offset > 0 {
            file.seek(SeekFrom::Start(offset))
                .map_err(|error| encode_error(classify(&error), error))?;
        }
        Ok(Self {
            file,
            opened_id: identity(path),
            path: PathBuf::from(path),
        })
    }
}

impl StreamProducer for FileReader {
    fn next_chunk(&mut self) -> StreamStep {
        // Re-check identity on every chunk. A log that rotates mid-read would
        // otherwise appear as one continuous file, and the caller would commit
        // a spliced result. This is exactly the `ESTALE` case the proposal
        // separates from `ENOENT`.
        let current = identity(&self.path);
        if !self.opened_id.is_empty() && !current.is_empty() && current != self.opened_id {
            return StreamStep::Failed(encode_error(
                Code::Stale,
                format!("{} was replaced during read", self.path.display()),
            ));
        }

        let mut buffer = vec![0u8; CHUNK];
        match self.file.read(&mut buffer) {
            Ok(0) => StreamStep::Done,
            Ok(read) => {
                buffer.truncate(read);
                StreamStep::Chunk(buffer)
            }
            Err(error) => StreamStep::Failed(encode_error(classify(&error), error)),
        }
    }
}

// --- write (consumer) ------------------------------------------------------

/// Take a stream from the host and write it to a file.
///
/// The reply is **deferred** until the stream ends: the request is not
/// answerable at handler time, because "how many bytes did you write" is only
/// known after the last chunk. That is what [`Peer::on_deferred`] exists for.
///
/// `mode: "append"` ignores the cursor (verified behaviour): under multiple
/// writers, `seek(End)` + `write` has a race that append mode does not.
fn register_write(peer: &Arc<Peer>) {
    let target = Arc::clone(peer);
    peer.on_deferred(
        "hands.write",
        Arc::new(move |reply: DeferredReply, args: Vec<Value>| {
            let path = str_arg(&args, 0);
            let opts = args.get(2).cloned().unwrap_or_else(|| json!({}));
            // `write(path, data, opts?)` — the stream is argument 1, per the
            // proposal's signature. kkrpc rewrites an async-iterable argument
            // into a stream-ref envelope, which the peer unwraps first.
            let sid = stream_ref_id(&args, 1);

            let Some(sid) = sid else {
                reply.fail(encode_error(
                    Code::Unsupported,
                    "hands.write: argument 2 is not a stream reference",
                ));
                return;
            };

            match FileWriter::open(&path, &opts) {
                Ok(writer) => {
                    // The sink owns the reply: "how many bytes did you write" is
                    // only answerable after the last chunk arrives.
                    let sink = Box::new(DeferredWriter {
                        writer,
                        reply: reply.clone(),
                        mode: writer_mode(&opts),
                    });
                    // `consume_stream` opens the credit window, so the host
                    // starts sending only after this returns. If it refuses
                    // (duplicate stream id), the reply is still owed.
                    if let Err(error) = target.consume_stream(&sid, sink) {
                        reply.fail(encode_error(Code::Stale, error));
                    }
                }
                Err(error) => reply.fail(error),
            }
        }),
    );
}

fn writer_mode(opts: &Value) -> &'static str {
    match opts.get("mode").and_then(Value::as_str) {
        Some("append") => "append",
        Some("truncate") => "truncate",
        _ => "create",
    }
}

struct FileWriter {
    file: File,
}

impl FileWriter {
    fn open(path: &str, opts: &Value) -> Result<Self, String> {
        let offset = opts.get("offset").and_then(Value::as_u64);
        let mode = writer_mode(opts);
        if mode == "append" && offset.is_some_and(|offset| offset > 0) {
            return Err(encode_error(
                Code::Unsupported,
                "hands.write: `append` and `offset > 0` are mutually exclusive",
            ));
        }
        let mut options = OpenOptions::new();
        options.write(true).create(true);
        match mode {
            "append" => {
                options.append(true);
            }
            "truncate" => {
                options.truncate(true);
            }
            _ => {
                options.truncate(false);
            }
        }
        let mut file = options
            .open(path)
            .map_err(|error| encode_error(classify(&error), error))?;
        if let Some(offset) = offset {
            file.seek(SeekFrom::Start(offset))
                .map_err(|error| encode_error(classify(&error), error))?;
        }
        Ok(Self { file })
    }
}

struct DeferredWriter {
    writer: FileWriter,
    reply: DeferredReply,
    mode: &'static str,
}

impl StreamSink for DeferredWriter {
    fn write(&mut self, bytes: &[u8]) -> Result<(), String> {
        self.writer
            .file
            .write_all(bytes)
            .map_err(|error| encode_error(classify(&error), error))
    }

    fn finish(&mut self, outcome: Result<(), String>) {
        match outcome {
            Ok(()) => {
                // The end offset comes from the file's own cursor, so `append`
                // mode reports where the bytes actually landed rather than where
                // the caller asked them to start — the two differ by design.
                let written = self.writer.file.stream_position().unwrap_or(0);
                let _ = self.writer.file.flush();
                self.reply.send(json!({
                    "bytes": written,
                    "endOffset": written,
                    "mode": self.mode,
                }));
            }
            Err(message) => self.reply.fail(message),
        }
    }
}

// --- watch (event stream) --------------------------------------------------

/// Watch a path and emit change events.
///
/// Two behaviours that are not obvious and are both measured
/// (`docs/probes/hand-io/rust-crates/FINDINGS.md` §4.1, §4.3):
///
/// 1. **A path that does not exist yet cannot be watched.** `watch()` errors,
///    and creating the file afterwards still delivers nothing. So when the
///    target is absent, the parent directory is watched instead and events are
///    filtered down to the target — the same shape as `tail --follow=name`.
/// 2. **No debouncer is needed for volume.** 200 appends through one handle
///    produced a single event, so events already coalesce.
fn register_watch(peer: &Arc<Peer>) {
    let target = Arc::clone(peer);
    peer.on_deferred(
        "hands.watch",
        Arc::new(move |reply: DeferredReply, args: Vec<Value>| {
            let path = str_arg(&args, 0);
            let opts = args.get(1).cloned().unwrap_or_else(|| json!({}));
            let recursive = opts
                .get("recursive")
                .and_then(Value::as_bool)
                .unwrap_or(false);

            match FileWatcher::start(&path, recursive) {
                Ok(watcher) => {
                    if let Err(error) =
                        target.open_event_stream(&reply_id(&reply), Box::new(watcher))
                    {
                        reply.fail(error);
                    }
                }
                Err(error) => reply.fail(error),
            }
        }),
    );
}

struct FileWatcher {
    rx: Receiver<notify::Result<notify::Event>>,
    watcher: RecommendedWatcher,
    /// The exact path the caller asked about. Events are filtered against it,
    /// because the watch may be installed on the parent directory.
    target: PathBuf,
    /// Whether the watch had to move up to the parent (target absent at start).
    watching_parent: bool,
}

impl FileWatcher {
    fn start(path: &str, recursive: bool) -> Result<Self, String> {
        let target = PathBuf::from(path);
        let (tx, rx) = mpsc::channel();
        let mut watcher = notify::recommended_watcher(move |event| {
            // A send failure means the consumer is gone; dropping is correct.
            let _ = tx.send(event);
        })
        .map_err(|error| encode_error(Code::Unsupported, error))?;

        let mode = if recursive {
            RecursiveMode::Recursive
        } else {
            RecursiveMode::NonRecursive
        };

        // Try the target itself first: a recursive watch on a directory only
        // works there, and a file that exists is watched most directly.
        let watching_parent = match watcher.watch(&target, mode) {
            Ok(()) => false,
            Err(_) => {
                let parent = target
                    .parent()
                    .filter(|parent| !parent.as_os_str().is_empty())
                    .ok_or_else(|| {
                        encode_error(
                            Code::NotFound,
                            format!("{} does not exist and has no parent", target.display()),
                        )
                    })?;
                // The parent must exist; if it does not, this path is not
                // watchable by any means and the caller needs to know now.
                if !parent.exists() {
                    return Err(encode_error(
                        Code::NotFound,
                        format!("{} does not exist", parent.display()),
                    ));
                }
                watcher
                    .watch(parent, RecursiveMode::NonRecursive)
                    .map_err(|error| encode_error(classify_anyhow(&error), error))?;
                true
            }
        };

        Ok(Self {
            rx,
            watcher,
            target,
            watching_parent,
        })
    }

    /// Translate one filesystem event into the proposal's `HandsChange` shape.
    fn change_of(event: &notify::Event) -> Option<Value> {
        use notify::EventKind;
        let kind = match event.kind {
            EventKind::Create(_) => "create",
            EventKind::Remove(_) => "remove",
            // A rename is reported as two name events; `replace` is the useful
            // summary for a rotation (the old file left, a new one arrived).
            EventKind::Modify(notify::event::ModifyKind::Name(_)) => "replace",
            EventKind::Modify(_) => "modify",
            EventKind::Access(_) => return None,
            _ => "modify",
        };
        let path = event.paths.first()?;
        Some(json!({
            "kind": kind,
            "path": path.to_string_lossy(),
            "id": identity(path),
        }))
    }
}

impl StreamSource for FileWatcher {
    fn next_value(&mut self, timeout: Duration) -> Option<Value> {
        let deadline = std::time::Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                // Nothing happened this tick. `None` means "quiet", not "done".
                return None;
            }
            match self.rx.recv_timeout(remaining) {
                Ok(Ok(event)) => {
                    // Filter to the requested path when the watch sits on the
                    // parent, so a sibling's churn does not surface as a change
                    // to the target.
                    if self.watching_parent && !event.paths.iter().any(|path| path == &self.target)
                    {
                        continue;
                    }
                    if let Some(change) = Self::change_of(&event) {
                        return Some(change);
                    }
                }
                Ok(Err(_)) => continue,
                Err(RecvTimeoutError::Timeout) => return None,
                Err(RecvTimeoutError::Disconnected) => return None,
            }
        }
    }

    fn close(&mut self) {
        // Explicit, so the watch is gone even if the watcher object outlives
        // this call. Best-effort by design: a failed unwatch must not panic the
        // stream thread.
        let _ = self.watcher.unwatch(&self.target);
    }
}

// --- shared helpers --------------------------------------------------------

/// Best-effort file identity. An empty string means "this filesystem cannot say"
/// — a network share — and callers must treat that as "unknown", not as "same".
fn identity(path: impl AsRef<Path>) -> String {
    file_id::get_file_id(path)
        .map(|id| format!("{id:?}"))
        .unwrap_or_default()
}

/// Read a stream reference out of an argument position, unwrapping the value
/// envelope first (kkrpc nests a stream ref inside a `"value"` envelope).
fn stream_ref_id(args: &[Value], index: usize) -> Option<String> {
    let value = args.get(index)?;
    value
        .get(crate::kkrpc_peer::STREAM_REF)
        .and_then(Value::as_str)
        .filter(|kind| *kind == "async-iterable")?;
    value.get("id").and_then(Value::as_str).map(str::to_string)
}

fn str_arg(args: &[Value], index: usize) -> String {
    args.get(index)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// `notify` hands back its own error type; only the io-ish part is useful here.
fn classify_anyhow(error: &notify::Error) -> Code {
    match error.kind {
        notify::ErrorKind::PathNotFound => Code::NotFound,
        notify::ErrorKind::Io(ref io) => classify(io),
        notify::ErrorKind::Generic(_) => Code::Unsupported,
        _ => Code::Unsupported,
    }
}

/// Re-exported so the tests can build a [`StreamSource`] without reaching into
/// the peer module's private items.
#[cfg(test)]
impl DeferredReply {
    /// A reply that records nothing and writes nowhere.
    ///
    /// Unit tests exercise the sink/source logic, which does not need a live
    /// transport; the deferred reply's wire behaviour is covered by the peer's
    /// own tests and by the end-to-end channel test.
    pub(crate) fn test_stub() -> Self {
        crate::kkrpc_peer::test_support::detached_reply()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "vrcxk-hands-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|delta| delta.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    /// The error text of an already-encoded failure.
    ///
    /// Written as a `match` rather than `expect_err` because the reader/writer
    /// types hold live handles and deliberately do not implement `Debug`.
    fn failure<T>(result: Result<T, String>) -> String {
        match result {
            Ok(_) => panic!("expected this to fail"),
            Err(message) => message,
        }
    }

    // --- stat ---------------------------------------------------------------

    #[test]
    fn stat_reports_size_identity_and_kind_for_a_file() {
        let dir = temp_dir("stat-file");
        let path = dir.join("a.txt");
        std::fs::write(&path, b"hello").expect("write");
        let stat = stat_path(path.to_str().unwrap()).expect("stat");
        std::fs::remove_dir_all(&dir).ok();

        assert_eq!(stat["size"], json!(5));
        assert_eq!(stat["kind"], json!("file"));
        assert!(
            stat["id"].as_str().is_some_and(|id| !id.is_empty()),
            "a local file must have an identity: {stat}"
        );
        assert!(stat["mtimeMs"].as_u64().is_some_and(|ms| ms > 0));
    }

    #[test]
    fn stat_reports_directories_rather_than_failing() {
        // Directories must be answerable: a caller deciding what to do next
        // needs to tell "a directory" from "nothing there".
        let dir = temp_dir("stat-dir");
        let stat = stat_path(dir.to_str().unwrap()).expect("stat");
        std::fs::remove_dir_all(&dir).ok();
        assert_eq!(stat["kind"], json!("dir"));
    }

    #[test]
    fn stat_of_a_missing_path_is_an_error_the_caller_maps_to_null() {
        let dir = temp_dir("stat-missing");
        let missing = dir.join("nope.txt");
        let error = stat_path(missing.to_str().unwrap()).expect_err("must fail");
        std::fs::remove_dir_all(&dir).ok();
        assert_eq!(classify(&error), Code::NotFound);
    }

    // --- read ---------------------------------------------------------------

    #[test]
    fn read_streams_a_file_in_bounded_chunks() {
        // The bound is the point: memory must not scale with file size.
        let dir = temp_dir("read-chunks");
        let path = dir.join("big.bin");
        let payload = vec![7u8; CHUNK * 2 + 13];
        std::fs::write(&path, &payload).expect("write");

        let mut reader = FileReader::open(path.to_str().unwrap(), 0).expect("open");
        let mut collected = Vec::new();
        loop {
            match reader.next_chunk() {
                StreamStep::Chunk(bytes) => {
                    assert!(bytes.len() <= CHUNK, "chunk exceeded the bound");
                    collected.extend_from_slice(&bytes);
                }
                StreamStep::Done => break,
                StreamStep::Failed(message) => panic!("unexpected failure: {message}"),
            }
        }
        std::fs::remove_dir_all(&dir).ok();
        assert_eq!(collected, payload);
    }

    #[test]
    fn read_honours_an_offset_for_resumption() {
        // `seek` is the whole resumption mechanism, so an offset must produce
        // exactly the tail — this is what makes resume work without a new verb.
        let dir = temp_dir("read-offset");
        let path = dir.join("resume.bin");
        std::fs::write(&path, b"0123456789").expect("write");

        let mut reader = FileReader::open(path.to_str().unwrap(), 4).expect("open");
        let mut collected = Vec::new();
        loop {
            match reader.next_chunk() {
                StreamStep::Chunk(bytes) => collected.extend_from_slice(&bytes),
                StreamStep::Done => break,
                StreamStep::Failed(message) => panic!("unexpected failure: {message}"),
            }
        }
        std::fs::remove_dir_all(&dir).ok();
        assert_eq!(collected, b"456789");
    }

    #[test]
    fn read_of_a_replaced_file_fails_stale_rather_than_splicing() {
        // The failure this prevents is silent: rotation mid-read would return a
        // file that never existed on disk, and the caller would store it.
        let dir = temp_dir("read-stale");
        let path = dir.join("rotating.log");
        std::fs::write(&path, vec![1u8; CHUNK * 2]).expect("write");

        let mut reader = FileReader::open(path.to_str().unwrap(), 0).expect("open");
        assert!(matches!(reader.next_chunk(), StreamStep::Chunk(_)));

        // Rotate: move the old file aside and put a NEW file at the same path.
        std::fs::rename(&path, dir.join("rotating.log.1")).expect("rename");
        std::fs::write(&path, b"fresh").expect("write new");

        let outcome = reader.next_chunk();
        std::fs::remove_dir_all(&dir).ok();
        match outcome {
            StreamStep::Failed(message) => assert!(
                message.starts_with("ESTALE"),
                "a replaced file must report ESTALE, got: {message}"
            ),
            other => panic!(
                "expected ESTALE, got {}",
                match other {
                    StreamStep::Chunk(_) => "a chunk".to_string(),
                    StreamStep::Done => "a clean end".to_string(),
                    StreamStep::Failed(message) => message,
                }
            ),
        }
    }

    #[test]
    fn read_of_a_missing_file_reports_not_found_not_stale() {
        // The distinction the proposal insists on: these two need opposite
        // handling, so they must not collapse into one code.
        let dir = temp_dir("read-missing");
        let missing = dir.join("nope.bin");
        let error = FileReader::open(missing.to_str().unwrap(), 0)
            .err()
            .expect("must fail");
        std::fs::remove_dir_all(&dir).ok();
        assert!(error.starts_with("ENOENT"), "got: {error}");
    }

    // --- write --------------------------------------------------------------

    #[test]
    fn write_creates_and_reports_the_end_offset() {
        let dir = temp_dir("write-create");
        let path = dir.join("out.bin");
        let writer = FileWriter::open(path.to_str().unwrap(), &json!({})).expect("open");
        let mut sink = DeferredWriter {
            writer,
            reply: DeferredReply::test_stub(),
            mode: "create",
        };
        sink.write(b"abc").expect("write");
        sink.write(b"de").expect("write");
        let written = sink.writer.file.stream_position().expect("position");
        sink.finish(Ok(()));
        std::fs::remove_dir_all(&dir).ok();
        assert_eq!(written, 5);
    }

    #[test]
    fn append_mode_ignores_a_moved_cursor() {
        // Documented and measured: this is the only correct shape for a rolling
        // log under concurrent writers, because seek-then-write races.
        let dir = temp_dir("write-append");
        let path = dir.join("log.txt");
        std::fs::write(&path, b"first").expect("seed");

        let mut writer =
            FileWriter::open(path.to_str().unwrap(), &json!({ "mode": "append" })).expect("open");
        // Move the cursor backwards; append must ignore it.
        writer.file.seek(SeekFrom::Start(0)).expect("seek");
        writer.file.write_all(b"+second").expect("write");
        let contents = std::fs::read_to_string(&path).expect("read");
        std::fs::remove_dir_all(&dir).ok();
        assert_eq!(contents, "first+second");
    }

    #[test]
    fn append_with_a_nonzero_offset_is_rejected_as_a_contradiction() {
        let dir = temp_dir("write-contradiction");
        let path = dir.join("x.txt");
        let error = FileWriter::open(
            path.to_str().unwrap(),
            &json!({ "mode": "append", "offset": 5 }),
        )
        .err()
        .expect("must fail");
        std::fs::remove_dir_all(&dir).ok();
        assert!(error.starts_with("EUNSUPPORTED"), "got: {error}");
    }

    // --- watch --------------------------------------------------------------

    #[test]
    fn watch_falls_back_to_the_parent_when_the_target_does_not_exist() {
        // Without this, tailing a log that has not been created yet fails — the
        // "application started before its log existed" case.
        let dir = temp_dir("watch-missing");
        let missing = dir.join("not-yet.log");
        let watcher = FileWatcher::start(missing.to_str().unwrap(), false).expect("start");
        let fell_back = watcher.watching_parent;
        drop(watcher);
        std::fs::remove_dir_all(&dir).ok();
        assert!(fell_back, "an absent target must watch its parent");
    }

    #[test]
    fn watch_emits_a_create_for_a_file_that_did_not_exist() {
        let dir = temp_dir("watch-create");
        let target = dir.join("appears.log");
        let mut watcher = FileWatcher::start(target.to_str().unwrap(), false).expect("start");

        std::fs::write(&target, b"hello\n").expect("write");

        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut seen = None;
        while seen.is_none() && std::time::Instant::now() < deadline {
            if let Some(change) = watcher.next_value(Duration::from_millis(200)) {
                seen = Some(change);
            }
        }
        watcher.close();
        std::fs::remove_dir_all(&dir).ok();

        let change = seen.expect("a create event for the new file");
        assert_eq!(change["kind"], json!("create"));
    }

    #[test]
    fn watch_filters_out_siblings_when_it_sits_on_the_parent() {
        // The fallback widens the watch to the whole directory, so without the
        // filter a neighbouring file's churn would be reported as a change to
        // the target — a silent correctness bug for a log tailer.
        let dir = temp_dir("watch-filter");
        let target = dir.join("wanted.log");
        let sibling = dir.join("unwanted.log");
        let mut watcher = FileWatcher::start(target.to_str().unwrap(), false).expect("start");
        assert!(watcher.watching_parent);

        // Create only the sibling; it must not be reported as the target.
        std::fs::write(&sibling, b"noise\n").expect("write");
        let observed = watcher.next_value(Duration::from_millis(700));
        watcher.close();
        std::fs::remove_dir_all(&dir).ok();

        assert!(
            observed.is_none(),
            "a sibling's change must not be attributed to the target: {observed:?}"
        );
    }

    #[test]
    fn watch_reports_modifications_to_an_existing_file() {
        let dir = temp_dir("watch-modify");
        let target = dir.join("live.log");
        std::fs::write(&target, b"start\n").expect("seed");
        let mut watcher = FileWatcher::start(target.to_str().unwrap(), false).expect("start");
        assert!(
            !watcher.watching_parent,
            "an existing file is watched directly"
        );

        std::fs::write(&target, b"start\nmore\n").expect("append");

        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut count = 0;
        while count == 0 && std::time::Instant::now() < deadline {
            if watcher.next_value(Duration::from_millis(200)).is_some() {
                count += 1;
            }
        }
        watcher.close();
        std::fs::remove_dir_all(&dir).ok();
        assert!(count > 0, "a modification must be delivered");
    }

    #[test]
    fn a_missing_watch_target_inside_a_missing_directory_fails_loudly() {
        // Silently accepting this would give the caller a watch that can never
        // fire, which looks exactly like "nothing is happening".
        let dir = temp_dir("watch-nodir");
        let deeper = dir.join("no-such-dir").join("file.log");
        let error = FileWatcher::start(deeper.to_str().unwrap(), false)
            .err()
            .expect("must fail");
        std::fs::remove_dir_all(&dir).ok();
        assert!(error.starts_with("ENOENT"), "got: {error}");
    }

    // --- error surface ------------------------------------------------------

    #[test]
    fn error_codes_are_prefixed_so_they_survive_the_wire() {
        // kkrpc's error frame only carries {name, message}; a structured field
        // would be dropped, so the code must live inside the message.
        assert_eq!(encode_error(Code::Stale, "x"), "ESTALE: x");
        assert_eq!(encode_error(Code::NotFound, "x"), "ENOENT: x");
        assert_ne!(Code::Stale.as_str(), Code::NotFound.as_str());
    }

    #[test]
    fn a_directory_read_is_reported_as_eisdir_not_as_a_generic_failure() {
        let dir = temp_dir("read-dir");
        let error = failure(FileReader::open(dir.to_str().unwrap(), 0));
        std::fs::remove_dir_all(&dir).ok();
        assert!(error.starts_with("EISDIR"), "got: {error}");
    }
}
