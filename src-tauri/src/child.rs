//! Child-process host for Aperture scripts.
//!
//! Phase 1 uses the system `node` binary on PATH — Phase 6 swaps in the bundled
//! Bun-provided Node. We pass a tiny loader (`--import ./runtime-shim/loader.mjs`)
//! which installs a virtual-module resolver for `aperture:runtime` and, via a
//! `--eval` bootstrap, loads the user script and orchestrates `onLoad` /
//! `onExit` against NDJSON stdio.
//!
//! Env vars are NOT inherited by default. Phase 1 passes through a minimal
//! safelist; the full `export const env = [...]` approval flow lands in Phase 6.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;

use parking_lot::Mutex;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, Mutex as AsyncMutex};
use tokio::time::{timeout, Duration};

use crate::ndjson::{LineFramer, ParseOutcome};

/// Rolling buffer of the last N stderr bytes — surfaced in the death screen
/// when the child exits non-zero without having emitted a structured `error`
/// event.
const STDERR_TAIL_CAP: usize = 8 * 1024;

/// Upper bound for the per-script stderr log file. When the file exceeds this
/// at open time, or grows past it during a session, it's truncated to keep
/// only the most-recent tail. Prevents unbounded growth across sessions.
const LOG_FILE_CAP: u64 = 5 * 1024 * 1024;

/// Messages the host emits to the rest of the app.
#[derive(Debug)]
pub enum HostEvent {
    /// A well-formed NDJSON value from stdout — caller dispatches as
    /// `ScriptEvent` if the shape validates.
    Stdout(serde_json::Value),
    /// A malformed line — recorded but not fatal.
    ParseError { line: String, error: String },
    /// A single stderr line.
    Stderr(String),
    /// The child exited.
    Exit {
        code: Option<i32>,
        signal: Option<String>,
        stderr_tail: String,
    },
}

pub struct ChildHandle {
    /// `tokio::sync::Mutex` (not parking_lot) because we hold the guard
    /// across `.await` when writing to stdin — a `parking_lot::MutexGuard`
    /// is !Send and makes `#[tauri::command]` futures fail the Send bound.
    stdin: Arc<AsyncMutex<Option<ChildStdin>>>,
    child: Arc<Mutex<Option<Child>>>,
}

/// Lightweight clone that shares the same stdin slot — used by Tauri
/// commands (e.g. `send_to_child`) that want to forward a line without
/// holding the main `AppState.child` mutex across `.await`.
pub struct ChildStdinRef {
    stdin: Arc<AsyncMutex<Option<ChildStdin>>>,
}

impl ChildStdinRef {
    pub async fn send_line(&self, line: &str) -> std::io::Result<()> {
        let mut guard = self.stdin.lock().await;
        if let Some(stdin) = guard.as_mut() {
            stdin.write_all(line.as_bytes()).await?;
            if !line.ends_with('\n') {
                stdin.write_all(b"\n").await?;
            }
            stdin.flush().await?;
        }
        Ok(())
    }
}

impl ChildHandle {
    pub fn clone_for_stdin(&self) -> ChildStdinRef {
        ChildStdinRef {
            stdin: self.stdin.clone(),
        }
    }

    /// Write a line of JSON to the child's stdin. Silently drops if stdin is
    /// already closed (script exited).
    pub async fn send_line(&self, line: &str) -> std::io::Result<()> {
        let mut guard = self.stdin.lock().await;
        if let Some(stdin) = guard.as_mut() {
            stdin.write_all(line.as_bytes()).await?;
            if !line.ends_with('\n') {
                stdin.write_all(b"\n").await?;
            }
            stdin.flush().await?;
        }
        Ok(())
    }

    /// Send `{"type":"cancel","reason":"window-close"}`, wait up to 5s for exit, then SIGKILL.
    pub async fn shutdown_with_grace(&self) {
        let _ = self.send_line(r#"{"type":"cancel","reason":"window-close"}"#).await;
        // Close stdin so the child sees EOF even if it isn't listening for
        // cancel yet (Phase 4 wires the real handler).
        {
            let mut guard = self.stdin.lock().await;
            *guard = None;
        }
        let waiter = {
            let child = self.child.clone();
            async move {
                loop {
                    let status = {
                        let mut guard = child.lock();
                        match guard.as_mut() {
                            Some(c) => c.try_wait().ok().flatten(),
                            None => return,
                        }
                    };
                    if status.is_some() {
                        return;
                    }
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            }
        };
        if timeout(Duration::from_secs(5), waiter).await.is_err() {
            let mut guard = self.child.lock();
            if let Some(c) = guard.as_mut() {
                let _ = c.start_kill();
            }
        }
    }
}

pub struct Spawned {
    pub handle: ChildHandle,
    pub events: mpsc::UnboundedReceiver<HostEvent>,
}

pub struct SpawnConfig {
    pub node_bin: PathBuf,
    pub loader_module: PathBuf,
    pub bootstrap_module: PathBuf,
    pub script_path: PathBuf,
    pub cwd: PathBuf,
    /// Raw CLI flag pairs (`--key value`), passed through untouched for the
    /// shim to merge with URL query params and validate against `schema`.
    pub cli_flags_json: String,
    /// The original source argument — local path or `http(s)://…` URL — used
    /// by the shim to extract URL query params for merging.
    pub source: String,
    /// Phase-2 cache key, or empty string when the script declined caching
    /// (no `// @aperture-version` comment). See cache_key.rs.
    pub cache_key: String,
    /// Absolute path to `~/.aperture/state/` so the shim can persist/load.
    pub state_dir: PathBuf,
    /// Additional `node_modules` directories appended to `NODE_PATH`.
    pub node_paths: Vec<PathBuf>,
    /// Approved env vars from `export const env = [...]` (Phase 6).
    pub approved_env: std::collections::HashMap<String, String>,
    /// Whether launched in dev mode (verbose tracing, worker analysis).
    pub dev_mode: bool,
    /// Path to the per-script stderr log file, if caching is enabled.
    pub log_path: Option<PathBuf>,
}

/// Spawn the Aperture script as a child process. Env vars are NOT inherited by
/// default — only the OS safelist plus approved script env vars are forwarded.
pub fn spawn(cfg: SpawnConfig) -> std::io::Result<Spawned> {
    let mut cmd = Command::new(&cfg.node_bin);
    cmd.arg("--import")
        .arg(path_to_file_url(&cfg.loader_module))
        .arg(&cfg.bootstrap_module)
        .arg(&cfg.script_path)
        .env_clear();

    // OS minimum required for Node to start and locate tmp/home.
    for (k, v) in env_safelist() {
        cmd.env(k, v);
    }
    // Script-declared approved env vars (Phase 6).
    for (k, v) in &cfg.approved_env {
        cmd.env(k, v);
    }

    cmd.env("APERTURE_SCRIPT", &cfg.script_path);
    cmd.env("APERTURE_SOURCE", &cfg.source);
    cmd.env("APERTURE_CLI_FLAGS", &cfg.cli_flags_json);
    cmd.env("APERTURE_CACHE_KEY", &cfg.cache_key);
    cmd.env("APERTURE_STATE_DIR", &cfg.state_dir);
    if cfg.dev_mode {
        cmd.env("APERTURE_DEV", "1");
    }
    if let Some(ref lp) = cfg.log_path {
        cmd.env("APERTURE_LOG_PATH", lp);
    }
    if !cfg.node_paths.is_empty() {
        let sep = if cfg!(windows) { ";" } else { ":" };
        let joined: String = cfg
            .node_paths
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join(sep);
        cmd.env("NODE_PATH", joined);
    }
    cmd.current_dir(&cfg.cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = cmd.spawn()?;
    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");
    let stdin = child.stdin.take().expect("stdin piped");

    let (tx, rx) = mpsc::unbounded_channel();
    let child = Arc::new(Mutex::new(Some(child)));
    let stdin = Arc::new(AsyncMutex::new(Some(stdin)));

    // stdout → NDJSON framer → HostEvent::Stdout / ParseError
    {
        let tx = tx.clone();
        tokio::spawn(async move {
            let mut reader = stdout;
            let mut buf = [0u8; 8192];
            let mut framer = LineFramer::new();
            loop {
                let n = match reader.read(&mut buf).await {
                    Ok(0) => break,
                    Ok(n) => n,
                    Err(_) => break,
                };
                for outcome in framer.push(&buf[..n]) {
                    dispatch_outcome(&tx, outcome);
                }
            }
            for outcome in framer.flush() {
                dispatch_outcome(&tx, outcome);
            }
        });
    }

    // stderr → rolling tail + per-line events + optional ring-buffer log file
    let stderr_tail = Arc::new(Mutex::new(Vec::<u8>::with_capacity(STDERR_TAIL_CAP)));
    {
        let tx = tx.clone();
        let tail = stderr_tail.clone();
        let log_path = cfg.log_path.clone();
        tokio::spawn(async move {
            // Open log file if configured. Enforce LOG_FILE_CAP at open time by
            // truncating pre-existing content from the front. During the session
            // we rotate when the running total exceeds the cap.
            let mut log_file: Option<tokio::fs::File> = None;
            let mut log_bytes_written: u64 = 0;
            if let Some(ref lp) = log_path {
                rotate_if_oversized(lp).await;
                log_bytes_written = tokio::fs::metadata(lp).await.map(|m| m.len()).unwrap_or(0);
                if let Ok(f) = tokio::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(lp)
                    .await
                {
                    log_file = Some(f);
                }
            }

            let mut reader = stderr;
            let mut buf = [0u8; 4096];
            let mut line_buf = Vec::<u8>::new();
            loop {
                let n = match reader.read(&mut buf).await {
                    Ok(0) => break,
                    Ok(n) => n,
                    Err(_) => break,
                };
                {
                    let mut t = tail.lock();
                    t.extend_from_slice(&buf[..n]);
                    if t.len() > STDERR_TAIL_CAP {
                        let drop = t.len() - STDERR_TAIL_CAP;
                        t.drain(..drop);
                    }
                }
                // Write to log file (fire-and-forget, errors are non-fatal).
                if let Some(ref mut f) = log_file {
                    let _ = tokio::io::AsyncWriteExt::write_all(f, &buf[..n]).await;
                    log_bytes_written = log_bytes_written.saturating_add(n as u64);
                    if log_bytes_written > LOG_FILE_CAP {
                        // Close current handle, rotate, reopen at new (smaller) tail.
                        drop(log_file.take());
                        if let Some(ref lp) = log_path {
                            rotate_if_oversized(lp).await;
                            log_bytes_written =
                                tokio::fs::metadata(lp).await.map(|m| m.len()).unwrap_or(0);
                            if let Ok(f) = tokio::fs::OpenOptions::new()
                                .create(true)
                                .append(true)
                                .open(lp)
                                .await
                            {
                                log_file = Some(f);
                            }
                        }
                    }
                }
                for byte in &buf[..n] {
                    if *byte == b'\n' {
                        let line = String::from_utf8_lossy(&line_buf).trim_end().to_string();
                        line_buf.clear();
                        if !line.is_empty() {
                            let _ = tx.send(HostEvent::Stderr(line));
                        }
                    } else {
                        line_buf.push(*byte);
                    }
                }
            }
            if !line_buf.is_empty() {
                let line = String::from_utf8_lossy(&line_buf).trim_end().to_string();
                if !line.is_empty() {
                    let _ = tx.send(HostEvent::Stderr(line));
                }
            }
        });
    }

    // Exit watcher.
    {
        let child = child.clone();
        let tx = tx.clone();
        let tail = stderr_tail.clone();
        tokio::spawn(async move {
            let status = {
                let mut taken = {
                    let mut guard = child.lock();
                    guard.take()
                };
                match taken.as_mut() {
                    Some(c) => c.wait().await.ok(),
                    None => None,
                }
            };
            let (code, signal) = match status {
                Some(s) => (s.code(), signal_of(&s)),
                None => (None, None),
            };
            let tail_str = {
                let t = tail.lock();
                String::from_utf8_lossy(&t).into_owned()
            };
            let _ = tx.send(HostEvent::Exit {
                code,
                signal,
                stderr_tail: tail_str,
            });
        });
    }

    Ok(Spawned {
        handle: ChildHandle { stdin, child },
        events: rx,
    })
}

/// If `path` exists and exceeds `LOG_FILE_CAP`, rewrite it so it contains only
/// the last `LOG_FILE_CAP / 2` bytes. Errors are non-fatal — logging is
/// best-effort and must not crash the script.
async fn rotate_if_oversized(path: &Path) {
    let size = match tokio::fs::metadata(path).await {
        Ok(m) => m.len(),
        Err(_) => return,
    };
    if size <= LOG_FILE_CAP {
        return;
    }
    let keep = (LOG_FILE_CAP / 2) as usize;
    // Read the whole file (bounded; the cap makes this fine), keep the tail.
    let data = match tokio::fs::read(path).await {
        Ok(d) => d,
        Err(_) => return,
    };
    let start = data.len().saturating_sub(keep);
    // Align to the next newline so we don't start mid-line.
    let aligned = data[start..]
        .iter()
        .position(|b| *b == b'\n')
        .map(|i| start + i + 1)
        .unwrap_or(start);
    let _ = tokio::fs::write(path, &data[aligned..]).await;
}

fn dispatch_outcome(tx: &mpsc::UnboundedSender<HostEvent>, o: ParseOutcome) {
    match o {
        ParseOutcome::Value(v) => {
            let _ = tx.send(HostEvent::Stdout(v));
        }
        ParseOutcome::Malformed { line, error } => {
            let _ = tx.send(HostEvent::ParseError { line, error });
        }
    }
}

#[cfg(unix)]
fn signal_of(status: &std::process::ExitStatus) -> Option<String> {
    use std::os::unix::process::ExitStatusExt;
    status.signal().map(|s| format!("SIG{}", s))
}

#[cfg(not(unix))]
fn signal_of(_status: &std::process::ExitStatus) -> Option<String> {
    None
}

fn env_safelist() -> HashMap<String, String> {
    // Minimum vars for Node.js to start and locate tmp/home on each OS.
    // Script-declared vars from `export const env = [...]` are added separately.
    let mut out = HashMap::new();
    let keys: &[&str] = &[
        "HOME",
        "PATH",
        "TMPDIR",
        "TMP",
        "TEMP",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "SystemRoot",
        "SYSTEMROOT",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
    ];
    for k in keys {
        if let Ok(v) = std::env::var(k) {
            out.insert((*k).to_string(), v);
        }
    }
    out
}

fn path_to_file_url(p: &Path) -> String {
    // Node's --import requires a file:// URL on all platforms.
    match url::Url::from_file_path(p) {
        Ok(u) => u.to_string(),
        Err(_) => p.display().to_string(),
    }
}
