//! Wire-protocol types. Mirrors `src/types.ts` on the frontend.
//!
//! The full `ScriptEvent` / `GUIEvent` unions are declared here — Phase 1 only
//! *acts* on `error` and `result`, but the backend forwards every variant to
//! the frontend so later phases plug in behavior by adding a match arm on
//! either side.
//!
//! The backend currently forwards the raw `serde_json::Value` rather than
//! round-tripping through these typed enums, so field-level typos would not
//! fail a build today. These types exist as the documented contract for
//! Phases 2+ to validate against.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Info,
    Warn,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ScriptEvent {
    #[serde(rename = "progress")]
    Progress {
        value: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<String>,
    },
    #[serde(rename = "log")]
    Log {
        level: LogLevel,
        message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        data: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source: Option<String>,
    },
    #[serde(rename = "state:set")]
    StateSet { key: String, value: Value },
    #[serde(rename = "state:set:chunk")]
    StateSetChunk {
        key: String,
        chunk: String,
        #[serde(rename = "final")]
        final_: bool,
    },
    #[serde(rename = "state:get")]
    StateGet {
        key: String,
        #[serde(rename = "callId")]
        call_id: String,
    },
    #[serde(rename = "invoke")]
    Invoke {
        #[serde(rename = "fn")]
        fn_name: String,
        args: Value,
        #[serde(rename = "callId")]
        call_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        stream: Option<bool>,
    },
    #[serde(rename = "result")]
    Result { data: Value },
    #[serde(rename = "error")]
    Error {
        message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        stack: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum GUIEvent {
    #[serde(rename = "state:set")]
    StateSet { key: String, value: Value },
    #[serde(rename = "state:changed")]
    StateChanged { key: String, value: Value },
    #[serde(rename = "state:get:reply")]
    StateGetReply {
        #[serde(rename = "callId")]
        call_id: String,
        value: Value,
    },
    #[serde(rename = "invoke:result")]
    InvokeResult {
        #[serde(rename = "callId")]
        call_id: String,
        result: Value,
    },
    #[serde(rename = "invoke:stream")]
    InvokeStream {
        #[serde(rename = "callId")]
        call_id: String,
        chunk: Value,
        #[serde(rename = "final")]
        final_: bool,
    },
    #[serde(rename = "call")]
    Call {
        #[serde(rename = "fn")]
        fn_name: String,
        args: Value,
        #[serde(rename = "callId")]
        call_id: String,
    },
    #[serde(rename = "cancel")]
    Cancel {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
}

/// Outer envelope the Tauri backend emits to the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum BackendMessage {
    Launch {
        source: String,
        cwd: String,
        #[serde(rename = "rawFlags")]
        raw_flags: std::collections::BTreeMap<String, String>,
        offline: bool,
    },
    Phase {
        phase: Phase,
    },
    Script {
        event: Value,
    },
    /// A fully-reassembled `state:set` derived from one or more
    /// `state:set:chunk` frames emitted by the script. The frontend treats
    /// this identically to a non-streamed `state:set` — reassembly is
    /// transparent per design.md §"Streaming Opt-In".
    StateSet {
        key: String,
        value: Value,
    },
    Stderr {
        line: String,
    },
    ParseError {
        line: String,
        error: String,
    },
    ChildExit {
        code: Option<i32>,
        signal: Option<String>,
        #[serde(rename = "stderrTail")]
        stderr_tail: String,
    },
    Fatal {
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        stack: Option<String>,
    },
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Installing,
    Running,
    Exiting,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn script_event_progress_roundtrip() {
        let raw = r#"{"type":"progress","value":0.5,"label":"halfway"}"#;
        let evt: ScriptEvent = serde_json::from_str(raw).unwrap();
        let back = serde_json::to_string(&evt).unwrap();
        assert!(back.contains("\"type\":\"progress\""));
        assert!(back.contains("\"value\":0.5"));
    }

    #[test]
    fn script_event_state_set_colon_tag() {
        let raw = r#"{"type":"state:set","key":"x","value":42}"#;
        let evt: ScriptEvent = serde_json::from_str(raw).unwrap();
        match evt {
            ScriptEvent::StateSet { key, value } => {
                assert_eq!(key, "x");
                assert_eq!(value, Value::from(42));
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn gui_event_invoke_result() {
        let raw = r#"{"type":"invoke:result","callId":"c1","result":{"ok":true}}"#;
        let evt: GUIEvent = serde_json::from_str(raw).unwrap();
        match evt {
            GUIEvent::InvokeResult { call_id, .. } => assert_eq!(call_id, "c1"),
            _ => panic!("wrong variant"),
        }
    }
}
