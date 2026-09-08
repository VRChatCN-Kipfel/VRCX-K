use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{ChildStdin, ChildStdout};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

static NEXT_ID: AtomicU64 = AtomicU64::new(1);
const ARG_ENVELOPE: &str = "__kkrpc_next_arg__";

pub type Handler = Arc<dyn Fn(Vec<Value>) -> Value + Send + Sync>;

pub struct Peer {
    writer: Mutex<ChildStdin>,
    pending: Mutex<HashMap<String, Sender<Result<Value, String>>>>,
    handlers: Mutex<HashMap<String, Handler>>,
}

impl Peer {
    /// Create a peer without consuming host stdout yet. Install mandatory
    /// handshake handlers before calling `start_reader()` so early frames stay
    /// buffered by the OS pipe rather than being dispatched as unknown.
    pub fn new(stdin: ChildStdin) -> Arc<Self> {
        Arc::new(Self {
            writer: Mutex::new(stdin),
            pending: Mutex::new(HashMap::new()),
            handlers: Mutex::new(HashMap::new()),
        })
    }

    pub fn start_reader(self: &Arc<Self>, stdout: ChildStdout) {
        let reader_peer = Arc::clone(self);
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut line = String::new();
                match reader.read_line(&mut line) {
                    Ok(0) | Err(_) => {
                        let mut pending = reader_peer.pending.lock().expect("pending");
                        for (_, sender) in pending.drain() {
                            let _ = sender.send(Err("host stdio closed".into()));
                        }
                        break;
                    }
                    Ok(_) => {}
                }
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
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

    pub fn call_timeout(
        &self,
        method: &str,
        args: Vec<Value>,
        timeout: Duration,
    ) -> Result<Value, String> {
        let id = format!("r-{}", NEXT_ID.fetch_add(1, Ordering::Relaxed));
        let (tx, rx) = mpsc::channel();
        self.pending.lock().expect("pending").insert(id.clone(), tx);
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
        if let Err(err) = self.write(&Value::Object(payload)) {
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
