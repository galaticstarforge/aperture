//! Stream-key chunk reassembly for `state:set:chunk` events.
//!
//! Script-side writes to a `.stream()` key are chunked into one or more
//! `{type: 'state:set:chunk', key, chunk, final}` events. The frontend is
//! oblivious to chunking (design.md §"Streaming Opt-In": "reassembly on the
//! GUI side is transparent"), so the backend buffers chunks per key and
//! only forwards a single reassembled `state:set` when `final: true`.
//!
//! Mid-stream collision policy (phase doc risk: "last writer replaces
//! buffer"): if a non-chunked write arrives for a key with a pending
//! buffer, the buffer is dropped and the direct write is forwarded.

use std::collections::HashMap;

use serde_json::Value;

#[derive(Default)]
pub struct ChunkBuffers {
    pending: HashMap<String, String>,
}

#[derive(Debug)]
pub enum ChunkOutcome {
    /// Buffering in progress — nothing to forward.
    Buffering,
    /// Reassembled into a single `state:set` — forward the key/value to the
    /// frontend.
    Assembled { key: String, value: Value },
    /// The chunk was malformed or reassembly failed — forward a diagnostic.
    Failed { key: String, error: String },
}

impl ChunkBuffers {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed a single `state:set:chunk` event (the raw `Value` that came off
    /// the wire). Returns an outcome describing what the caller should do
    /// next.
    pub fn feed_chunk(&mut self, ev: &Value) -> ChunkOutcome {
        let key = match ev.get("key").and_then(Value::as_str) {
            Some(k) => k.to_string(),
            None => {
                return ChunkOutcome::Failed {
                    key: String::new(),
                    error: "state:set:chunk event is missing `key`".into(),
                };
            }
        };
        let chunk = ev.get("chunk").and_then(Value::as_str).unwrap_or_default();
        let is_final = ev.get("final").and_then(Value::as_bool).unwrap_or(false);

        let entry = self.pending.entry(key.clone()).or_default();
        entry.push_str(chunk);

        if !is_final {
            return ChunkOutcome::Buffering;
        }

        let full = self.pending.remove(&key).unwrap_or_default();
        match serde_json::from_str::<Value>(&full) {
            Ok(value) => ChunkOutcome::Assembled { key, value },
            Err(err) => ChunkOutcome::Failed {
                key,
                error: err.to_string(),
            },
        }
    }

    /// Called whenever a non-chunked `state:set` comes in — drops any
    /// pending buffer for that key so the direct write wins (last-writer-
    /// replaces-buffer policy).
    pub fn drop_pending(&mut self, key: &str) {
        self.pending.remove(key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn single_final_chunk() {
        let mut bufs = ChunkBuffers::new();
        let ev = json!({"type": "state:set:chunk", "key": "x", "chunk": "\"hi\"", "final": true});
        match bufs.feed_chunk(&ev) {
            ChunkOutcome::Assembled { key, value } => {
                assert_eq!(key, "x");
                assert_eq!(value, json!("hi"));
            }
            other => panic!("wrong outcome: {:?}", other),
        }
    }

    #[test]
    fn multi_chunk_reassembly() {
        let mut bufs = ChunkBuffers::new();
        let full = json!({"a": 1, "b": [1, 2, 3], "c": "hello"}).to_string();
        let mid = full.len() / 2;
        let c1 = &full[..mid];
        let c2 = &full[mid..];
        let r1 = bufs.feed_chunk(&json!({"type": "state:set:chunk", "key": "k", "chunk": c1, "final": false}));
        match r1 {
            ChunkOutcome::Buffering => {}
            _ => panic!("expected buffering"),
        }
        let r2 = bufs.feed_chunk(&json!({"type": "state:set:chunk", "key": "k", "chunk": c2, "final": true}));
        match r2 {
            ChunkOutcome::Assembled { value, .. } => {
                assert_eq!(value.get("a"), Some(&json!(1)));
                assert_eq!(value.get("c"), Some(&json!("hello")));
            }
            _ => panic!("expected assembled"),
        }
    }

    #[test]
    fn drop_pending_replaces() {
        let mut bufs = ChunkBuffers::new();
        let _ = bufs.feed_chunk(&json!({"type": "state:set:chunk", "key": "k", "chunk": "\"par", "final": false}));
        bufs.drop_pending("k");
        // Now a new chunk comes in; should start fresh.
        let r = bufs.feed_chunk(&json!({"type": "state:set:chunk", "key": "k", "chunk": "\"ok\"", "final": true}));
        match r {
            ChunkOutcome::Assembled { value, .. } => assert_eq!(value, json!("ok")),
            _ => panic!("expected fresh assembly"),
        }
    }

    #[test]
    fn malformed_json_surfaces() {
        let mut bufs = ChunkBuffers::new();
        let r = bufs.feed_chunk(&json!({"type": "state:set:chunk", "key": "k", "chunk": "{not json", "final": true}));
        match r {
            ChunkOutcome::Failed { key, .. } => assert_eq!(key, "k"),
            _ => panic!("expected failure"),
        }
    }
}
