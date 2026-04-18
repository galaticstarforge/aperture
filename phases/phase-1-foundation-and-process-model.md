# Phase 1 — Foundation & Process Model

> Build the skeleton: a Tauri shell, a CLI entry point, a child-process script
> host, and an NDJSON protocol between them. No state, no real UI — just the
> bones on which everything else hangs.

## Goal

A user can run `aperture ./empty.mjs <cwd>` and see a window open, have
`onLoad`/`onExit` execute in a child process, and — if the script throws — land
on a full-window death screen with a working "Reload Script" button.

## Scope (in)

From `design.md`:

- §"What It Is" — CLI and Binary surfaces as separate entry points
- §"Binary / GUI Runtime" — argument parsing (`<script-source> <working-dir>`),
  URL-vs-path dispatch, `cwd` handling
- §"Communication Architecture" — NDJSON over stdio between Tauri backend and
  child process; stderr captured as raw log output; no per-frame size cap
- §"Event Envelope" — full `ScriptEvent` / `GUIEvent` type surface defined and
  parsed (even if most events are unhandled stubs this phase)
- §"Script Lifecycle" — cache-check → GUI launch → spinner → onLoad → interactive
  → onExit → grace → exit flow, minus the cache/install/dep portions
- §"Error Boundary" — full-window death screen with message, stack, Reload button
- §"The Runtime Module" — virtual `aperture:runtime` module shim that imports
  resolve against a shim bundled at script load time; all exports present as
  stubs so scripts don't fail to import
- §"Filesystem Layout" — create `~/.aperture/` and all subdirs on first run
- §"Execution Runtime Details" — child process (not in-process); `cwd` set from
  argv; stdout/stderr streamed not buffered; `.mjs`-only
- Install/update screen chrome (strings + indeterminate progress bar) — **shell
  only**; the actual install logic lands in Phase 6
- Multi-instance policy: one instance per canonical script path; second launches
  refuse with a user-visible error and focus the existing window

## Scope (out)

Explicitly deferred to later phases:

- State system, zod schemas, watchers, persistence (Phase 2)
- UI element registry and renderer (Phase 3) — Phase 1 ships a placeholder
  "script running…" view plus the death screen
- `invoke` suite, `progress`, `log`, `signal`, formatters (Phase 4)
- Tables, trees, charts, timelines, workers (Phase 5)
- CLI sub-commands beyond the binary entry point (`new`, `dev`, `validate`,
  `run`, `docs`), dep installs via bun, semver caching (Phase 6)
- Window size/position persistence (Phase 6)

## Work Items

### Tauri + React + Vite shell

- Scaffold a Tauri 2.x project with React + Vite frontend.
- Apply dark-theme-only chrome at the app root (semantic token CSS vars:
  `success | danger | warning | info | neutral`; hex strings pass through).
- Wire React Bits primitives and Lucide icons so downstream phases can reach
  for them by name without re-plumbing bundler config.

### CLI / binary entry point

- Argv parsing: `aperture <script-source> <working-dir>` plus a pre-scan for
  `--offline` and CLI key-value flags (flag values stored raw for Phase 2 to
  validate).
- URL-vs-path dispatch: `http://` / `https://` → fetch later (Phase 6); any
  other value → local path, resolved absolute. For Phase 1, reject remote URLs
  with a clear "remote sources land in Phase 6" error so we don't ship
  half-working behavior.
- Canonical-path computation for multi-instance guard (strip query params,
  resolve symlinks). Use a lock file at `~/.aperture/locks/<hash>.lock` + OS
  window-focus IPC (Tauri single-instance plugin) to enforce one window per
  canonical script path.
- Exit with a user-visible error when a second launch races an existing one.

### Filesystem layout

Create on first run if missing, idempotent:

```
~/.aperture/
├── config.json       # empty JSON object initially
├── deps/             # empty
├── scripts/          # empty
├── state/            # empty
├── windows/          # empty
├── logs/             # empty (ring-buffered in Phase 6)
└── locks/            # phase-1 addition for multi-instance guard
```

### Child process host

- Spawn the script as a child process using the bundled Bun-provided Node
  runtime (bundling lands in Phase 6; for Phase 1, use a system Node to
  unblock development and document the upgrade path).
- `cwd` set from argv.
- Env vars NOT inherited by default — Phase 1 passes through a minimal
  safelist (`HOME`, `PATH`, `TMPDIR`, platform analogues) with a TODO marker
  for the full `export const env = [...]` approval flow in Phase 6.
- Stream stdout (NDJSON) and stderr (raw) to the Tauri backend; stream — do
  not buffer.
- Hard timeout hook plumbed but unused — real timeout / SIGKILL ladder is
  wired in Phase 4 alongside the cancellation signal.

### NDJSON protocol framing

- Line-delimited JSON parser on the Tauri side; one event per line; malformed
  lines emit an error on the log panel and are skipped (never crash the
  parser).
- Full `ScriptEvent` union recognized at the type level so later phases plug in
  handlers by adding a case. For Phase 1 only `error` and a no-op `result` are
  acted on; every other event type is logged and ignored.
- Full `GUIEvent` union likewise defined. Phase 1 emits none of them from the
  frontend yet.
- `tauri::emit()` fans events out to the React frontend; `tauri::listen()`
  accepts events from the frontend and writes them line-by-line to the child's
  stdin.

### Virtual `aperture:runtime` module

- Register an import resolver (via esbuild/rollup plugin or a Node
  `--import`/`module.register` loader) that intercepts `aperture:runtime`
  and returns a shim module.
- Shim exports the full API surface from §"The Runtime Module" as stubs:
  - `progress`, `log` — wired to stdout events (work in Phase 4 makes them
    useful end-to-end; in Phase 1 they already emit valid NDJSON so onLoad
    can at least log).
  - `state`, `invoke`, `invokeStream`, `on`, `createWorker`, `params`,
    `signal` — present as typed stubs that throw a clear "not implemented
    until Phase N" error when called.
- Shim is injected ahead of the user script; never lands on disk.

### Lifecycle skeleton

- On launch: run multi-instance guard, create FS layout if absent, then show
  the placeholder install/update screen with the copy:
  - First run: `Installing dependencies…`
  - Version change: `Updating to vX.Y.Z…`
  - Indeterminate progress bar.
  - Phase 1 treats every script as "first run" and dismisses the screen after a
    fixed short delay once the child process is ready; Phase 6 replaces the
    fixed delay with the real install/cache pipeline.
- After dismiss: show a neutral full-window "Script running…" scrim until
  onLoad resolves; dismiss scrim on first `result` event (or after a hard
  cap + warning log if onLoad never completes).
- On window close: send a `cancel` event down stdin, wait for onExit to
  complete within a 5s grace window, then terminate the child. Real
  AbortSignal plumbing inside the child lands in Phase 4.

### Error boundary / death screen

- Any uncaught error in the child (surface: `error` event OR non-zero exit code
  with stderr tail) swaps the window contents for the full-window death
  screen:
  - Error message (monospace)
  - Stack trace (monospace, scrollable)
  - **Reload Script** button → tears down the child, re-runs the launch flow
    on the same source+cwd.
- Cmd/Ctrl+R keyboard shortcut maps to the same Reload action. (Other
  shortcut defaults arrive with the UI work in Phase 3.)

## Acceptance Criteria

1. Running `aperture ./hello.mjs <cwd>` where `hello.mjs` has an empty
   `onLoad` opens a window, shows the placeholder running view, and keeps the
   window alive until the user closes it.
2. Running a script that `throw`s inside `onLoad` replaces the window with the
   death screen. Clicking Reload relaunches the same script.
3. Running a script that closes `runtime.log('hi')` emits a `log` NDJSON line
   on stdout that the Tauri backend parses and forwards to the frontend —
   visible in a dev-tools console log for now. (Real log panel UI is Phase 3.)
4. A second `aperture ./hello.mjs <cwd>` launch against the same canonical
   path exits with a user-visible error and focuses the first window.
5. `~/.aperture/` and all subdirectories exist after first launch; a second
   launch does not recreate or modify them.
6. Remote URL script sources (`https://…`) are rejected with a clear "deferred
   to Phase 6" error. No half-working download path ships.
7. Malformed NDJSON on the child's stdout produces an error log entry and is
   skipped; the backend parser never crashes.
8. Closing the window sends `cancel` on stdin, waits up to 5s for the child to
   exit, then kills it. (The child doesn't yet know what to do with `cancel`
   — that's Phase 4.)

## Dependencies

- None. Phase 1 is the foundation.

## Risks & Open Questions

- **Bundled Bun vs system Node.** Design requires bundled Node via Bun, but
  that is a packaging concern. Phase 1 uses system Node to unblock; Phase 6
  swaps in the bundled runtime. Document this contract so tests written in
  Phase 1 don't bake in a system-Node assumption that later breaks.
- **Single-instance race.** Tauri's single-instance plugin has known
  platform quirks on Linux. Lock-file fallback at `~/.aperture/locks/` gives
  us a portable baseline.
- **Virtual module strategy.** Node's `module.register` hooks vs an esbuild
  pre-bundle of the shim — tentative choice: `module.register` because it
  preserves `.mjs` native module semantics and allows the script to be the
  literal file on disk. Validate during Phase 1.
- Design.md open question "GUI crash recovery" is NOT addressed here; Phase 1
  assumes a Tauri crash tears down the child too.
