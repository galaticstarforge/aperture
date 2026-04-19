//! Activity log — per-run JSONL file capturing everything an LLM consumer
//! would need to understand what the script did and how the user interacted
//! with it.
//!
//! File format: JSON Lines (`.jsonl`). Each line is a standalone JSON object
//! with at minimum `{ "ts": <ms since epoch>, "type": <event kind> }`.
//!
//! Path: `~/.aperture/activity/<unix_secs>-<cache_key>.jsonl`.

use serde_json::{json, Value};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

static FILE: OnceLock<Mutex<std::fs::File>> = OnceLock::new();
static PATH: OnceLock<PathBuf> = OnceLock::new();

pub fn init(dir: &Path, script: &str, cache_key: &str) {
    if FILE.get().is_some() {
        return;
    }
    if let Err(e) = std::fs::create_dir_all(dir) {
        eprintln!("[activity] could not create {}: {}", dir.display(), e);
        return;
    }
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let ck = if cache_key.is_empty() { "anon" } else { cache_key };
    let path = dir.join(format!("{}-{}.jsonl", secs, ck));
    match OpenOptions::new().create(true).append(true).open(&path) {
        Ok(f) => {
            let _ = FILE.set(Mutex::new(f));
            let _ = PATH.set(path.clone());
            log(json!({
                "ts": now_ms(),
                "type": "start",
                "script": script,
                "cacheKey": cache_key,
                "path": path.display().to_string(),
            }));
        }
        Err(e) => {
            eprintln!("[activity] could not open {}: {}", path.display(), e);
        }
    }
}

pub fn path() -> Option<PathBuf> {
    PATH.get().cloned()
}

pub fn log(event: Value) {
    let Some(mtx) = FILE.get() else { return };
    let Ok(mut f) = mtx.lock() else { return };
    if let Ok(line) = serde_json::to_string(&event) {
        let _ = writeln!(f, "{line}");
        let _ = f.flush();
    }
}

/// Convert a child→host script event into an activity entry, if relevant.
/// Filters out internal plumbing (manifest, ui:update, format:result, chunks).
pub fn record_script_event(value: &Value) {
    let ty = value.get("type").and_then(Value::as_str).unwrap_or("");
    let ts = now_ms();
    match ty {
        "log" => {
            let mut entry = json!({
                "ts": ts,
                "type": "log",
                "level": value.get("level").cloned().unwrap_or(Value::String("info".into())),
                "message": value.get("message").cloned().unwrap_or(Value::Null),
            });
            if let Some(data) = value.get("data") {
                entry["data"] = data.clone();
            }
            if let Some(src) = value.get("source") {
                entry["source"] = src.clone();
            }
            log(entry);
        }
        "error" => log(json!({
            "ts": ts,
            "type": "error",
            "message": value.get("message").cloned().unwrap_or(Value::Null),
            "stack": value.get("stack").cloned().unwrap_or(Value::Null),
        })),
        "result" => log(json!({
            "ts": ts,
            "type": "result",
            "data": value.get("data").cloned().unwrap_or(Value::Null),
        })),
        "invoke" => log(json!({
            "ts": ts,
            "type": "script-invoke",
            "fn": value.get("fn").cloned().unwrap_or(Value::Null),
            "args": value.get("args").cloned().unwrap_or(Value::Null),
            "callId": value.get("callId").cloned().unwrap_or(Value::Null),
        })),
        _ => {}
    }
}

/// Convert a host→child event (from `send_to_child`) into an activity entry.
pub fn record_host_event(value: &Value) {
    let ty = value.get("type").and_then(Value::as_str).unwrap_or("");
    let ts = now_ms();
    match ty {
        "call" => log(json!({
            "ts": ts,
            "type": "user-action",
            "fn": value.get("fn").cloned().unwrap_or(Value::Null),
            "args": value.get("args").cloned().unwrap_or(Value::Null),
            "callId": value.get("callId").cloned().unwrap_or(Value::Null),
        })),
        "state:changed" => log(json!({
            "ts": ts,
            "type": "user-state-change",
            "key": value.get("key").cloned().unwrap_or(Value::Null),
            "value": value.get("value").cloned().unwrap_or(Value::Null),
        })),
        "invoke:result" => log(json!({
            "ts": ts,
            "type": "invoke-result",
            "callId": value.get("callId").cloned().unwrap_or(Value::Null),
            "result": value.get("result").cloned().unwrap_or(Value::Null),
            "error": value.get("error").cloned().unwrap_or(Value::Null),
        })),
        _ => {}
    }
}

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}
