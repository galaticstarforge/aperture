//! Aperture Phase 6 Tauri entry point.
//!
//! Dispatches CLI subcommands (new/validate/run/docs) without starting Tauri,
//! then launches the GUI for `dev` and default GUI-launch mode.
//!
//! Phase 6 additions over Phase 5:
//!   - CLI subcommand dispatch (new/validate/run/docs/dev)
//!   - Remote URL downloading and semver-aware caching
//!   - bun-backed dep install into `~/.aperture/deps/`
//!   - Env-var approval flow (pre-launch dialog)
//!   - Window geometry persistence
//!   - Stderr ring-buffer logging to `~/.aperture/logs/<cache-key>.log`
//!   - Multi-instance polish (focus existing window, exit 0)
//!   - Dev-mode protocol inspector

pub mod activity;
pub mod cache_key;
pub mod child;
pub mod chunks;
pub mod cli;
pub mod config;
pub mod deps;
pub mod diag;
pub mod events;
pub mod fs_layout;
pub mod invoke_cmds;
pub mod lock;
pub mod ndjson;
pub mod remote;
pub mod subcommands;

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc;

use crate::child::{ChildHandle, HostEvent, SpawnConfig, Spawned};
use crate::chunks::{ChunkBuffers, ChunkOutcome};
use crate::cli::{ApertureCommand, ParsedArgs};
use crate::events::{BackendMessage, Phase};
use crate::fs_layout::Layout;
use crate::subcommands::BundledPaths;

const EVENT_CHANNEL: &str = "aperture://message";

// ─────────────────────────────── AppState ─────────────────────────────────────

pub struct AppState {
    pub args: ParsedArgs,
    pub layout: Layout,
    pub bundled: BundledAssets,
    pub child: Mutex<Option<ChildHandle>>,
    pub session: AtomicU64,
    pub dev_mode: bool,
    pub cache_key: Mutex<String>,
    /// One-shot channel for the env-approval frontend response.
    pub env_approval_tx: Mutex<Option<tokio::sync::oneshot::Sender<bool>>>,
    /// One-shot channel fired when the frontend signals it is ready to receive events.
    pub frontend_ready_tx: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    /// Watch channel: lifecycle_entry sets true once the child process is spawned.
    pub child_running: tokio::sync::watch::Sender<bool>,
    /// Event queue: all backend→frontend messages go here; frontend polls via poll_events.
    pub event_tx: mpsc::UnboundedSender<Value>,
    pub event_rx: tokio::sync::Mutex<mpsc::UnboundedReceiver<Value>>,
}

#[derive(Clone)]
pub struct BundledAssets {
    pub loader_module: PathBuf,
    pub bootstrap_module: PathBuf,
    pub node_paths: Vec<PathBuf>,
}

impl BundledAssets {
    pub fn resolve() -> std::io::Result<Self> {
        let bp = BundledPaths::resolve()?;
        Ok(Self {
            loader_module: bp.loader_module,
            bootstrap_module: bp.bootstrap_module,
            node_paths: bp.node_paths,
        })
    }
}

// ─────────────────────────────── run() ────────────────────────────────────────

pub fn run() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_target(false)
        .init();

    let raw_args: Vec<String> = std::env::args().collect();
    let command = match cli::parse_command(raw_args) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("aperture: {}", e);
            std::process::exit(2);
        }
    };

    // ── Non-GUI subcommands: handle without Tauri ──────────────────────────────
    match &command {
        ApertureCommand::New { name } => {
            if let Err(e) = subcommands::cmd_new(name.clone()) {
                eprintln!("aperture: {e}");
                std::process::exit(1);
            }
            return Ok(());
        }
        ApertureCommand::Docs { section } => {
            if let Err(e) = subcommands::cmd_docs(section.clone()) {
                eprintln!("aperture: {e}");
                std::process::exit(1);
            }
            return Ok(());
        }
        ApertureCommand::Validate { script, headless_lint } => {
            let bundled = match BundledPaths::resolve() {
                Ok(b) => b,
                Err(e) => {
                    eprintln!("aperture: runtime shim not found: {e}");
                    std::process::exit(2);
                }
            };
            if let Err(e) = subcommands::cmd_validate(script.clone(), *headless_lint, &bundled) {
                eprintln!("aperture: {e}");
                std::process::exit(1);
            }
            return Ok(());
        }
        ApertureCommand::HeadlessRun(args) => {
            let bundled = match BundledPaths::resolve() {
                Ok(b) => b,
                Err(e) => {
                    eprintln!("aperture: runtime shim not found: {e}");
                    std::process::exit(2);
                }
            };
            if let Err(e) = subcommands::cmd_run(args.clone(), &bundled) {
                eprintln!("aperture: {e}");
                std::process::exit(1);
            }
            return Ok(());
        }
        ApertureCommand::GuiLaunch(_) | ApertureCommand::DevLaunch(_) => {}
    }

    // ── GUI launch (GuiLaunch + DevLaunch) ─────────────────────────────────────
    let (parsed, dev_mode) = match command {
        ApertureCommand::GuiLaunch(p) => (p, false),
        ApertureCommand::DevLaunch(p) => (p, true),
        _ => unreachable!(),
    };

    let layout = Layout::resolve()?;
    layout.ensure()?;
    diag::init(&layout.logs);

    let canonical = parsed.source.canonical_identity();
    match lock::try_acquire(&layout.locks, &canonical)? {
        lock::LockOutcome::Acquired(held) => {
            tracing::info!(lock = %held.path.display(), "acquired instance lock");
            let held = Box::leak(Box::new(held));
            let _ = &held.path;
        }
        lock::LockOutcome::AlreadyHeld { path } => {
            // Phase 6: focus the existing window and exit 0.
            eprintln!(
                "aperture: script already running — focusing existing window ({})",
                path.display()
            );
            // The running process will receive a single-instance notification
            // via the Tauri plugin and focus its window. We exit cleanly.
            std::process::exit(0);
        }
    }

    let bundled = BundledAssets::resolve().map_err(|e| {
        anyhow::anyhow!("runtime shim not found: {} (expected runtime-shim/ next to the binary)", e)
    })?;

    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<()>();
    let (child_running_tx, _child_running_rx) = tokio::sync::watch::channel(false);
    let (event_tx, event_rx) = mpsc::unbounded_channel::<Value>();
    let state = Arc::new(AppState {
        args: parsed,
        layout,
        bundled,
        child: Mutex::new(None),
        session: AtomicU64::new(0),
        dev_mode,
        cache_key: Mutex::new(String::new()),
        env_approval_tx: Mutex::new(None),
        frontend_ready_tx: Mutex::new(Some(ready_tx)),
        child_running: child_running_tx,
        event_tx,
        event_rx: tokio::sync::Mutex::new(event_rx),
    });

    tauri::Builder::default()
        .manage(state.clone())
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // Focus our window when a second launch of the same script happens.
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_focus();
            }
        }))
        .invoke_handler(tauri::generate_handler![
            frontend_ready,
            reload_script,
            send_to_child,
            env_approve,
            save_window_geometry,
            open_log_file,
            poll_events,
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
                lifecycle_entry(handle, state, ready_rx).await;
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
            // Persist window geometry on resize/move (debounce is handled on the
            // frontend — it calls save_window_geometry after the 500 ms timeout).
        })
        .run(tauri::generate_context!())?;

    Ok(())
}

// ─────────────────────────────── Tauri commands ───────────────────────────────

#[tauri::command]
async fn frontend_ready(app: AppHandle, state: tauri::State<'_, Arc<AppState>>) -> Result<serde_json::Value, String> {
    let cache_key = state.cache_key.lock().clone();
    let geometry = if !cache_key.is_empty() {
        config::WindowGeometry::load(&state.layout.windows, &cache_key)
    } else {
        None
    };

    let msg = BackendMessage::Launch {
        source: state.args.source.as_display(),
        cwd: state.args.cwd.display().to_string(),
        raw_flags: state.args.raw_flags.clone(),
        offline: state.args.offline,
        dev_mode: state.dev_mode,
        persisted_geometry: geometry.map(|g| serde_json::json!({
            "width": g.width, "height": g.height, "x": g.x, "y": g.y
        })),
    };
    emit(&app, &msg);

    // Unblock lifecycle_entry.
    if let Some(tx) = state.frontend_ready_tx.lock().take() {
        let _ = tx.send(());
    }

    // Wait for the child to be spawned (or timeout after 30 s).
    let mut rx = state.child_running.subscribe();
    diag::diag!("frontend_ready: waiting for child_running signal");
    let running = tokio::time::timeout(
        tokio::time::Duration::from_secs(30),
        rx.wait_for(|v| *v),
    ).await.is_ok();
    diag::diag!("frontend_ready: child_running={running} — returning to frontend");

    Ok(serde_json::json!({ "phase": if running { "running" } else { "timeout" } }))
}

#[tauri::command]
async fn reload_script(app: AppHandle, state: tauri::State<'_, Arc<AppState>>) -> Result<(), String> {
    state.session.fetch_add(1, Ordering::SeqCst);
    {
        let child = { state.child.lock().take() };
        if let Some(c) = child {
            c.shutdown_with_grace().await;
        }
    }
    let state_clone: Arc<AppState> = (*state).clone();
    tauri::async_runtime::spawn(async move {
        // On reload the frontend is already listening; use a pre-fired channel.
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        let _ = tx.send(());
        lifecycle_entry(app, state_clone, rx).await;
    });
    Ok(())
}

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
    activity::record_host_event(&event);
    handle.send_line(&line).await.map_err(|e| e.to_string())
}

/// Called by the frontend when the user approves/denies env-var access.
#[tauri::command]
async fn env_approve(
    state: tauri::State<'_, Arc<AppState>>,
    approved: bool,
    vars: Vec<String>,
) -> Result<(), String> {
    if approved {
        // Persist approval to config.
        let mut cfg = config::ApertureConfig::load(&state.layout.config_json);
        let cache_key = state.cache_key.lock().clone();
        cfg.approve(&cache_key, vars);
        let _ = cfg.save(&state.layout.config_json);
    }
    let tx = state.env_approval_tx.lock().take();
    if let Some(tx) = tx {
        let _ = tx.send(approved);
    }
    Ok(())
}

/// Called by the frontend after a debounced resize/move event.
#[tauri::command]
async fn save_window_geometry(
    state: tauri::State<'_, Arc<AppState>>,
    width: f64,
    height: f64,
    x: f64,
    y: f64,
) -> Result<(), String> {
    let cache_key = state.cache_key.lock().clone();
    if cache_key.is_empty() {
        return Ok(());
    }
    let geom = config::WindowGeometry { width, height, x, y };
    geom.save(&state.layout.windows, &cache_key)
        .map_err(|e| e.to_string())
}

/// Opens the current script's log file with the OS default application.
#[tauri::command]
async fn open_log_file(state: tauri::State<'_, Arc<AppState>>) -> Result<(), String> {
    let cache_key = state.cache_key.lock().clone();
    if cache_key.is_empty() {
        return Err("no cache key — log file unavailable".into());
    }
    let log_path = state.layout.logs.join(format!("{}.log", cache_key));
    if !log_path.exists() {
        return Err(format!("log file not found: {}", log_path.display()));
    }
    open::that(&log_path).map_err(|e| e.to_string())
}

// ─────────────────────────────── lifecycle ────────────────────────────────────

async fn lifecycle_entry(
    app: AppHandle,
    state: Arc<AppState>,
    frontend_ready: tokio::sync::oneshot::Receiver<()>,
) {
    let session = state.session.fetch_add(1, Ordering::SeqCst) + 1;
    diag::diag!("lifecycle_entry: session={session} — waiting for frontend_ready");

    // Wait for the frontend to register its event listener before emitting anything.
    let _ = frontend_ready.await;
    diag::diag!("lifecycle_entry: frontend_ready received — emitting Phase::Installing");
    emit(&app, &BackendMessage::Phase { phase: Phase::Installing });

    // ── Resolve the script path (download if remote) ───────────────────────────
    diag::diag!("lifecycle_entry: resolving script path");
    let script_path = match resolve_script(&app, &state, session).await {
        Some(p) => p,
        None => {
            diag::diag!("lifecycle_entry: resolve_script returned None — aborting");
            return;
        }
    };
    diag::diag!("lifecycle_entry: script_path={}", script_path.display());

    // ── Parse deps + env from script header ────────────────────────────────────
    let script_deps = deps::parse_deps_from_script(&script_path);
    let script_env = config::parse_env_from_script(&script_path);
    diag::diag!("lifecycle_entry: deps={:?}  env_vars={:?}", script_deps, script_env);

    // ── Compute / store cache key ──────────────────────────────────────────────
    let cache_key = cache_key::derive(&script_path)
        .ok()
        .flatten()
        .unwrap_or_default();
    *state.cache_key.lock() = cache_key.clone();
    diag::diag!("lifecycle_entry: cache_key={:?}", cache_key);

    activity::init(
        &state.layout.activity,
        &script_path.display().to_string(),
        &cache_key,
    );

    // ── Env-var approval ───────────────────────────────────────────────────────
    if !script_env.is_empty() {
        let cfg = config::ApertureConfig::load(&state.layout.config_json);
        if !cfg.is_approved(&cache_key, &script_env) {
            // Ask the frontend to show the approval dialog.
            let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
            *state.env_approval_tx.lock() = Some(tx);
            emit_if_current(
                &app,
                &state,
                session,
                &BackendMessage::EnvApproval {
                    vars: script_env.clone(),
                    cache_key: cache_key.clone(),
                },
            );
            match rx.await {
                Ok(true) => {} // approved — continue
                Ok(false) | Err(_) => {
                    emit_if_current(
                        &app,
                        &state,
                        session,
                        &BackendMessage::Fatal {
                            message: "Env-var access denied by user.".to_string(),
                            stack: None,
                        },
                    );
                    return;
                }
            }
        }
    }

    // ── Dep install ────────────────────────────────────────────────────────────
    if !script_deps.is_empty() {
        emit_if_current(
            &app,
            &state,
            session,
            &BackendMessage::InstallProgress {
                label: "Installing dependencies…".to_string(),
            },
        );
        match deps::ensure_deps(&state.layout.deps, &script_deps).await {
            Ok(_) => {}
            Err(e) => {
                emit_if_current(
                    &app,
                    &state,
                    session,
                    &BackendMessage::Fatal {
                        message: format!("Dependency install failed:\n{e}"),
                        stack: None,
                    },
                );
                return;
            }
        }
    }

    // ── Build approved env map ─────────────────────────────────────────────────
    let approved_env = config::build_approved_env(&script_env);

    // ── Node binary ───────────────────────────────────────────────────────────
    diag::diag!("lifecycle_entry: resolving node binary");
    let node_bin = match resolve_node() {
        Ok(p) => {
            diag::diag!("lifecycle_entry: node found at {}", p.display());
            p
        }
        Err(err) => {
            diag::diag!("lifecycle_entry: node NOT found — {err}");
            emit_if_current(
                &app,
                &state,
                session,
                &BackendMessage::Fatal {
                    message: format!(
                        "Could not find Node.js on PATH: {err}. Phase 6 bundles Node via Bun."
                    ),
                    stack: None,
                },
            );
            return;
        }
    };

    // ── Extra NODE_PATH for shared deps ───────────────────────────────────────
    let mut node_paths = state.bundled.node_paths.clone();
    let shared_nm = state.layout.deps.join("node_modules");
    if shared_nm.is_dir() {
        node_paths.push(shared_nm);
    }
    diag::diag!("lifecycle_entry: node_paths={:?}", node_paths);

    let cli_flags_json =
        serde_json::to_string(&state.args.raw_flags).unwrap_or_else(|_| "{}".to_string());

    // ── Log file path ─────────────────────────────────────────────────────────
    let log_path = if !cache_key.is_empty() {
        Some(state.layout.logs.join(format!("{}.log", cache_key)))
    } else {
        None
    };

    let cfg = SpawnConfig {
        node_bin,
        loader_module: state.bundled.loader_module.clone(),
        bootstrap_module: state.bundled.bootstrap_module.clone(),
        script_path,
        cwd: state.args.cwd.clone(),
        cli_flags_json,
        source: state.args.source.as_display(),
        cache_key: cache_key.clone(),
        state_dir: state.layout.state.clone(),
        node_paths,
        approved_env,
        dev_mode: state.dev_mode,
        log_path,
    };

    diag::diag!("lifecycle_entry: loader={} bootstrap={} script={}",
        state.bundled.loader_module.display(),
        state.bundled.bootstrap_module.display(),
        cfg.script_path.display());
    diag::diag!("lifecycle_entry: spawning child process");
    let Spawned { handle, events } = match child::spawn(cfg) {
        Ok(s) => s,
        Err(err) => {
            diag::diag!("lifecycle_entry: spawn FAILED — {err}");
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
    diag::diag!("lifecycle_entry: child spawned OK — emitting Phase::Running");
    let _ = state.child_running.send(true);

    {
        let mut slot = state.child.lock();
        *slot = Some(handle);
    }

    emit_if_current(&app, &state, session, &BackendMessage::Phase { phase: Phase::Running });
    diag::diag!("lifecycle_entry: entering drive loop");
    drive(app, state, session, events).await;
    diag::diag!("lifecycle_entry: drive loop exited (session={session})");
}

/// Resolve the local path for the script — downloading from remote URL if needed.
async fn resolve_script(app: &AppHandle, state: &Arc<AppState>, session: u64) -> Option<PathBuf> {
    match &state.args.source {
        cli::ScriptSource::LocalPath(p) => Some(p.clone()),
        cli::ScriptSource::RemoteUrl(raw_url) => {
            let canonical = state.args.source.canonical_identity();
            emit_if_current(
                app,
                state,
                session,
                &BackendMessage::InstallProgress {
                    label: "Downloading script…".to_string(),
                },
            );
            match remote::resolve_remote(
                raw_url,
                &canonical,
                &state.layout.scripts,
                state.args.offline,
            )
            .await
            {
                Ok(remote::FetchOutcome::CacheHit { script_path, cache_key }) => {
                    tracing::info!("cache hit: {}", cache_key);
                    Some(script_path)
                }
                Ok(remote::FetchOutcome::Downloaded { script_path, cache_key }) => {
                    tracing::info!("downloaded: {}", cache_key);
                    Some(script_path)
                }
                Ok(remote::FetchOutcome::Uncached { script_path }) => {
                    tracing::info!("uncached remote script (no @aperture-version)");
                    Some(script_path)
                }
                Err(e) => {
                    emit_if_current(
                        app,
                        state,
                        session,
                        &BackendMessage::Fatal {
                            message: format!("Failed to fetch script: {e}"),
                            stack: None,
                        },
                    );
                    None
                }
            }
        }
    }
}

// ─────────────────────────────── drive loop ───────────────────────────────────

async fn drive(
    app: AppHandle,
    state: Arc<AppState>,
    session: u64,
    mut events: mpsc::UnboundedReceiver<HostEvent>,
) {
    let mut chunks = ChunkBuffers::new();
    let mut event_count = 0u64;
    diag::diag!("drive: waiting for first child event");
    while let Some(ev) = events.recv().await {
        event_count += 1;
        if state.session.load(Ordering::SeqCst) != session {
            continue;
        }
        match ev {
            HostEvent::Stdout(ref value) => {
                let ty = value.get("type").and_then(|v| v.as_str()).unwrap_or("?");
                diag::diag!("drive: stdout event #{event_count} type={ty}");
                activity::record_script_event(value);
                if state.dev_mode {
                    emit(&app, &BackendMessage::ProtocolEvent {
                        direction: "inbound".to_string(),
                        event: value.clone(),
                    });
                }
                route_script_event(&app, &mut chunks, value.clone());
            }
            HostEvent::ParseError { ref line, ref error } => {
                diag::diag!("drive: parse-error #{event_count} err={error} line={line}");
                emit(&app, &BackendMessage::ParseError { line: line.clone(), error: error.clone() });
            }
            HostEvent::Stderr(ref line) => {
                diag::diag!("drive: stderr #{event_count} {line}");
                emit(&app, &BackendMessage::Stderr { line: line.clone() });
            }
            HostEvent::Exit { code, ref signal, ref stderr_tail } => {
                diag::diag!("drive: child EXIT code={code:?} signal={signal:?} stderr_tail={stderr_tail:?}");
                activity::log(serde_json::json!({
                    "ts": std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_millis()).unwrap_or(0),
                    "type": "exit",
                    "code": code,
                    "signal": signal,
                    "stderrTail": stderr_tail,
                }));
                emit(
                    &app,
                    &BackendMessage::ChildExit {
                        code,
                        signal: signal.clone(),
                        stderr_tail: stderr_tail.clone(),
                        log_available: has_log(&state),
                    },
                );
                break;
            }
        }
    }
    diag::diag!("drive: loop ended after {event_count} events");
}

fn has_log(state: &AppState) -> bool {
    let ck = state.cache_key.lock().clone();
    if ck.is_empty() { return false; }
    state.layout.logs.join(format!("{}.log", ck)).exists()
}

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
                emit(app, &BackendMessage::StateSet { key: key.to_string(), value: v });
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
    let current = state.session.load(Ordering::SeqCst);
    if current == session {
        emit(app, msg);
    } else {
        diag::diag!("emit_if_current: SKIPPED session mismatch current={current} expected={session}");
    }
}

fn emit(app: &AppHandle, msg: &BackendMessage) {
    let kind = match msg {
        BackendMessage::Phase { phase } => format!("phase::{phase:?}"),
        BackendMessage::Launch { .. } => "launch".to_string(),
        BackendMessage::Fatal { .. } => "fatal".to_string(),
        BackendMessage::ChildExit { code, .. } => format!("child-exit({code:?})"),
        _ => "other".to_string(),
    };
    diag::diag!("emit: {kind}");
    if let Some(state) = app.try_state::<Arc<AppState>>() {
        if let Ok(value) = serde_json::to_value(msg) {
            let _ = state.event_tx.send(value);
            return;
        }
    }
    // Fallback: direct window emit (keeps things working outside normal lifecycle).
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.emit(EVENT_CHANNEL, msg);
    }
}

#[tauri::command]
async fn poll_events(state: tauri::State<'_, Arc<AppState>>) -> Result<Value, String> {
    let mut rx = state.event_rx.lock().await;
    match rx.recv().await {
        Some(event) => Ok(event),
        None => Err("event channel closed".into()),
    }
}

fn resolve_node() -> std::io::Result<PathBuf> {
    subcommands::resolve_node()
}
