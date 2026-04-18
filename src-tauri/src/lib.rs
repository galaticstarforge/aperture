//! Aperture Phase 1 Tauri entry point.
//!
//! Responsibilities wired in this phase:
//! - Argv parsing (script source + cwd + flags + `--offline`)
//! - Multi-instance guard (file lock + Tauri single-instance plugin)
//! - Filesystem layout creation under `~/.aperture/`
//! - Script child-process host with NDJSON framing on stdout
//! - Lifecycle skeleton: installing → running → death screen
//! - Full-window death screen with Cmd/Ctrl+R "Reload Script"
//!
//! Out of scope (later phases): state/zod (Phase 2), element renderer
//! (Phase 3), `invoke` suite (Phase 4), workers (Phase 5), CLI subcommands
//! and dep installer (Phase 6).

pub mod cache_key;
pub mod child;
pub mod chunks;
pub mod cli;
pub mod events;
pub mod fs_layout;
pub mod invoke_cmds;
pub mod lock;
pub mod ndjson;

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc;

use crate::child::{ChildHandle, HostEvent, SpawnConfig, Spawned};
use crate::chunks::{ChunkBuffers, ChunkOutcome};
use crate::cli::ParsedArgs;
use crate::events::{BackendMessage, Phase};
use crate::fs_layout::Layout;

const EVENT_CHANNEL: &str = "aperture://message";

/// State shared across Tauri commands.
pub struct AppState {
    pub args: ParsedArgs,
    pub layout: Layout,
    pub bundled: BundledAssets,
    pub child: Mutex<Option<ChildHandle>>,
    /// Monotonic session counter. A drive loop emits nothing once its captured
    /// value lags the current value — this prevents a torn-down child's final
    /// `ChildExit` from reaching the frontend after a reload.
    pub session: AtomicU64,
}

#[derive(Clone)]
pub struct BundledAssets {
    pub loader_module: PathBuf,
    pub bootstrap_module: PathBuf,
    /// `node_modules` directories appended to `NODE_PATH` so the child can
    /// resolve `zod` (and, pre-Phase 6, any other shared packages) without
    /// installing them in the user's working dir.
    pub node_paths: Vec<PathBuf>,
}

impl BundledAssets {
    /// Locate the runtime shim. During dev we look beside the source tree;
    /// Phase 6 will bundle these into the Tauri resources dir.
    pub fn resolve() -> std::io::Result<Self> {
        let here = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|x| x.to_path_buf()));
        let candidates: Vec<PathBuf> = [
            here.as_ref().map(|p| p.join("runtime-shim")),
            Some(PathBuf::from("../runtime-shim")),
            Some(PathBuf::from("runtime-shim")),
            Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../runtime-shim")),
        ]
        .into_iter()
        .flatten()
        .collect();
        for c in &candidates {
            let loader = c.join("loader.mjs");
            let bootstrap = c.join("bootstrap.mjs");
            if loader.is_file() && bootstrap.is_file() {
                // Canonicalize so `url::Url::from_file_path` accepts them on
                // every platform (it rejects relative paths).
                let loader = std::fs::canonicalize(&loader).unwrap_or(loader);
                let bootstrap = std::fs::canonicalize(&bootstrap).unwrap_or(bootstrap);
                // node_modules typically sits alongside runtime-shim/ at
                // the repo root. Include both that and the Cargo manifest's
                // parent node_modules as fall-backs.
                let mut node_paths = Vec::new();
                if let Some(parent) = bootstrap.parent().and_then(|p| p.parent()) {
                    let nm = parent.join("node_modules");
                    if nm.is_dir() {
                        node_paths.push(nm);
                    }
                }
                let manifest_nm =
                    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../node_modules");
                if manifest_nm.is_dir() {
                    if let Ok(c) = std::fs::canonicalize(&manifest_nm) {
                        if !node_paths.iter().any(|p| p == &c) {
                            node_paths.push(c);
                        }
                    }
                }
                return Ok(Self {
                    loader_module: loader,
                    bootstrap_module: bootstrap,
                    node_paths,
                });
            }
        }
        Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "runtime-shim/loader.mjs not found",
        ))
    }
}

pub fn run() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_target(false)
        .init();

    let raw_args: Vec<String> = std::env::args().collect();
    let parsed = match cli::parse(raw_args.clone()) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("aperture: {}", e);
            std::process::exit(2);
        }
    };

    if parsed.source.is_remote() {
        eprintln!(
            "aperture: remote script sources are deferred to Phase 6 (got: {})",
            parsed.source.as_display()
        );
        std::process::exit(2);
    }

    let layout = Layout::resolve()?;
    layout.ensure()?;

    let canonical = parsed.source.canonical_identity();
    match lock::try_acquire(&layout.locks, &canonical)? {
        lock::LockOutcome::Acquired(held) => {
            tracing::info!(lock = %held.path.display(), "acquired instance lock");
            // Keep the lock alive for the process lifetime by leaking it into
            // a static — drop would release the flock and let a racing second
            // launch win.
            let held = Box::leak(Box::new(held));
            let _ = &held.path;
        }
        lock::LockOutcome::AlreadyHeld { path } => {
            eprintln!(
                "aperture: another instance is already running for this script ({})\n         the existing window will be focused",
                path.display()
            );
            // The Tauri single-instance plugin in the already-running process
            // will receive our argv and focus its window. Exit non-zero so
            // callers know this invocation didn't start anything new.
            std::process::exit(1);
        }
    }

    let bundled = BundledAssets::resolve().map_err(|e| {
        anyhow::anyhow!(
            "runtime shim not found: {} (expected runtime-shim/ next to the binary)",
            e
        )
    })?;

    let state = Arc::new(AppState {
        args: parsed,
        layout,
        bundled,
        child: Mutex::new(None),
        session: AtomicU64::new(0),
    });

    // Note: we intentionally do NOT use tauri-plugin-single-instance here.
    // That plugin enforces *global* single-instance, but Phase 1 policy is
    // one-per-canonical-script-path — so two Aperture windows for two
    // different scripts must both run. The file lock in `lock.rs` is the
    // portable, per-script baseline called for in the phase doc.
    tauri::Builder::default()
        .manage(state.clone())
        .invoke_handler(tauri::generate_handler![
            frontend_ready,
            reload_script,
            send_to_child,
            invoke_cmds::aperture_file_picker,
            invoke_cmds::aperture_notification,
            invoke_cmds::aperture_open_external,
            invoke_cmds::aperture_clipboard_read,
            invoke_cmds::aperture_clipboard_write,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            let state = state.clone();
            tauri::async_runtime::spawn(async move {
                lifecycle_entry(handle, state).await;
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let handle = window.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    if let Some(state) = handle.try_state::<Arc<AppState>>() {
                        let child = { state.child.lock().take() };
                        if let Some(c) = child {
                            c.shutdown_with_grace().await;
                        }
                    }
                });
            }
        })
        .run(tauri::generate_context!())?;

    Ok(())
}

#[tauri::command]
async fn frontend_ready(app: AppHandle, state: tauri::State<'_, Arc<AppState>>) -> Result<(), String> {
    // Re-emit the launch details once the frontend has subscribed.
    let msg = BackendMessage::Launch {
        source: state.args.source.as_display(),
        cwd: state.args.cwd.display().to_string(),
        raw_flags: state.args.raw_flags.clone(),
        offline: state.args.offline,
    };
    emit(&app, &msg);
    Ok(())
}

#[tauri::command]
async fn reload_script(app: AppHandle, state: tauri::State<'_, Arc<AppState>>) -> Result<(), String> {
    // Bump the session counter first so the old drive loop suppresses its
    // final ChildExit emission instead of leaking it as a crash.
    state.session.fetch_add(1, Ordering::SeqCst);
    {
        let child = { state.child.lock().take() };
        if let Some(c) = child {
            c.shutdown_with_grace().await;
        }
    }
    let state_clone: Arc<AppState> = (*state).clone();
    tauri::async_runtime::spawn(async move {
        lifecycle_entry(app, state_clone).await;
    });
    Ok(())
}

/// Forward a single GUIEvent JSON value into the running child's stdin as
/// one NDJSON line. The frontend uses this to deliver `state:set`,
/// `state:changed`, `cancel`, and (in Phase 4+) `invoke:result` events.
#[tauri::command]
async fn send_to_child(
    state: tauri::State<'_, Arc<AppState>>,
    event: serde_json::Value,
) -> Result<(), String> {
    let handle_opt = {
        let guard = state.child.lock();
        guard.as_ref().map(|h| h.clone_for_stdin())
    };
    let Some(handle) = handle_opt else {
        return Err("no running child".into());
    };
    let line = serde_json::to_string(&event).map_err(|e| e.to_string())?;
    handle.send_line(&line).await.map_err(|e| e.to_string())
}

async fn lifecycle_entry(app: AppHandle, state: Arc<AppState>) {
    let session = state.session.fetch_add(1, Ordering::SeqCst) + 1;
    emit(&app, &BackendMessage::Phase { phase: Phase::Installing });

    // Phase 1 treats every launch as first-run for the install screen —
    // we dismiss after a short fixed delay once the child is ready. Phase 6
    // replaces this with the real bun dep install pipeline.
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;

    let script_path = match state.args.source.local_path() {
        Some(p) => p.to_path_buf(),
        None => {
            emit_if_current(
                &app,
                &state,
                session,
                &BackendMessage::Fatal {
                    message: "Remote scripts are not supported until Phase 6.".to_string(),
                    stack: None,
                },
            );
            return;
        }
    };

    let cli_flags_json =
        serde_json::to_string(&state.args.raw_flags).unwrap_or_else(|_| "{}".to_string());

    let cache_key = cache_key::derive(&script_path)
        .ok()
        .flatten()
        .unwrap_or_default();

    let node_bin = match resolve_node() {
        Ok(p) => p,
        Err(err) => {
            emit_if_current(
                &app,
                &state,
                session,
                &BackendMessage::Fatal {
                    message: format!("Could not find Node.js on PATH: {err}. Phase 6 will bundle Node via Bun."),
                    stack: None,
                },
            );
            return;
        }
    };

    let cfg = SpawnConfig {
        node_bin,
        loader_module: state.bundled.loader_module.clone(),
        bootstrap_module: state.bundled.bootstrap_module.clone(),
        script_path,
        cwd: state.args.cwd.clone(),
        cli_flags_json,
        source: state.args.source.as_display(),
        cache_key,
        state_dir: state.layout.state.clone(),
        node_paths: state.bundled.node_paths.clone(),
    };

    let Spawned { handle, events } = match child::spawn(cfg) {
        Ok(s) => s,
        Err(err) => {
            emit_if_current(
                &app,
                &state,
                session,
                &BackendMessage::Fatal {
                    message: format!("Failed to spawn script child process: {err}"),
                    stack: None,
                },
            );
            return;
        }
    };

    {
        let mut slot = state.child.lock();
        *slot = Some(handle);
    }

    emit_if_current(&app, &state, session, &BackendMessage::Phase { phase: Phase::Running });
    drive(app, state, session, events).await;
}

async fn drive(
    app: AppHandle,
    state: Arc<AppState>,
    session: u64,
    mut events: mpsc::UnboundedReceiver<HostEvent>,
) {
    let mut chunks = ChunkBuffers::new();
    while let Some(ev) = events.recv().await {
        if state.session.load(Ordering::SeqCst) != session {
            // Superseded by a reload. Keep draining the channel so the old
            // child's pipes close cleanly, but drop any further frontend
            // emissions on the floor.
            continue;
        }
        match ev {
            HostEvent::Stdout(value) => {
                route_script_event(&app, &mut chunks, value);
            }
            HostEvent::ParseError { line, error } => {
                emit(&app, &BackendMessage::ParseError { line, error });
            }
            HostEvent::Stderr(line) => {
                emit(&app, &BackendMessage::Stderr { line });
            }
            HostEvent::Exit { code, signal, stderr_tail } => {
                emit(
                    &app,
                    &BackendMessage::ChildExit {
                        code,
                        signal,
                        stderr_tail,
                    },
                );
                break;
            }
        }
    }
}

/// Reassemble `state:set:chunk` frames into a single `state:set` for the
/// frontend, forward every other script event verbatim.
fn route_script_event(app: &AppHandle, chunks: &mut ChunkBuffers, value: Value) {
    let ty = value.get("type").and_then(Value::as_str).unwrap_or("");
    match ty {
        "state:set:chunk" => match chunks.feed_chunk(&value) {
            ChunkOutcome::Buffering => {}
            ChunkOutcome::Assembled { key, value } => {
                emit(app, &BackendMessage::StateSet { key, value });
            }
            ChunkOutcome::Failed { key, error } => {
                emit(
                    app,
                    &BackendMessage::ParseError {
                        line: format!("<chunk buffer for key={key}>"),
                        error,
                    },
                );
            }
        },
        "state:set" => {
            if let Some(key) = value.get("key").and_then(Value::as_str) {
                chunks.drop_pending(key);
                let v = value.get("value").cloned().unwrap_or(Value::Null);
                emit(
                    app,
                    &BackendMessage::StateSet {
                        key: key.to_string(),
                        value: v,
                    },
                );
                return;
            }
            emit(app, &BackendMessage::Script { event: value });
        }
        _ => {
            emit(app, &BackendMessage::Script { event: value });
        }
    }
}

fn emit_if_current(app: &AppHandle, state: &AppState, session: u64, msg: &BackendMessage) {
    if state.session.load(Ordering::SeqCst) == session {
        emit(app, msg);
    }
}

fn emit(app: &AppHandle, msg: &BackendMessage) {
    if let Err(err) = app.emit(EVENT_CHANNEL, msg) {
        tracing::warn!(?err, "failed to emit backend message");
    }
}

fn resolve_node() -> std::io::Result<PathBuf> {
    if let Ok(p) = std::env::var("APERTURE_NODE") {
        return Ok(PathBuf::from(p));
    }
    // Search PATH for `node` (or `node.exe` on Windows).
    let exe = if cfg!(windows) { "node.exe" } else { "node" };
    let path = std::env::var_os("PATH").ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::NotFound, "PATH is not set")
    })?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(exe);
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::NotFound,
        "`node` not found on PATH",
    ))
}
