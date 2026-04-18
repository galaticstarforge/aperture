# Phase 4 — Runtime Services & Invoke Suite

> Give scripts the OS-level primitives (file picker, confirm/prompt,
> notifications, clipboard, openExternal), first-class logging and progress,
> wired cancellation, custom formatters, and the full callback dispatch
> contract — including `meta.returnsInto`.

## Goal

Scripts can call `await invoke('filePicker', …)` and every other v1 invoke
target, stream results via `invokeStream`, emit structured logs and
progress, observe cancellation through `runtime.signal`, and rely on
`meta.returnsInto` to auto-write callback results into state. Custom
formatters — sync, async, rich output — land in tables, labels, and
anywhere `format` is accepted.

## Scope (in)

From `design.md`:

- §"The Runtime Module" / `progress` — `progress(value, label?)` emits a
  `progress` event; the shell's global progress indicator updates.
- §"The Runtime Module" / `log` — `log(msg, level, data?)` emits a
  structured event; level-colored in the log panel; `data` serialized as a
  collapsible JSON blob.
- §"`invoke` — Built-in Native Calls" — full v1 set:
  - `filePicker({ mode, filter, recursive })`
  - `confirm({ message })` — always `{ confirmed }`
  - `prompt({ message })` — always `{ confirmed, value }`
  - `notification({ title, body, level })`
  - `openExternal({ url, newWindow })`
  - `clipboard({ op: 'read' | 'write', text? })`
- §"`invokeStream`" — async iterator form for long-running invocations.
- §"`signal` — Cancellation" — `AbortSignal` fires on:
  1. User-initiated `cancel` (callback or GUI event).
  2. Hard timeout breach (configurable per-script; default from design).
  3. Window close (triggers `onExit` with a 5s grace before SIGKILL).
- §"Script Lifecycle" — the grace-period semantics for onExit;
  SIGKILL fallback.
- §"Callback Conventions" — `args` injection shapes (`rowDataAs`,
  `selectedAs`, plain `{}` for buttons); `runtime` as stable reference.
  This phase formalizes the dispatcher even though data-element injections
  (`rowDataAs`, `selectedAs`) are fully exercised in Phase 5.
- §"`meta` — Callback Metadata" — `returnsInto: 'key'` auto-writes the
  return value of a named callback into `state.key`. Watchers fire
  normally.
- §"Custom Formatters" — named `formatters` export:
  - Sync `(value, row) => string | { text, color }`.
  - Async formatters produce a placeholder shimmer until first resolution,
    then memoize per-input.
  - Built-in names (`bytes`, `ms`, `date`, `number`, `percent`,
    `relative`) share the namespace with custom; custom wins on collision.

## Scope (out)

- Data-element consumers of `args` injection (`rowDataAs`, `selectedAs`,
  `nodeDataAs`) — the mechanism lands here, the elements that feed it
  come in Phase 5.
- Worker-emitted `progress`/`log`/`state:get` — Phase 5.
- Backpressure policy for `invokeStream` — design open question; Phase 4
  ships with no explicit high-watermark, documented as a known gap.

## Work Items

### `progress` + `log`

- `progress(value, label?)` validates `0 ≤ value ≤ 1` in dev mode; emits
  `{ type: 'progress', value, label }`.
- The shell renders a top-level progress bar bound to the latest progress
  event, with `label` shown next to it. When `value === 1`, fade the bar
  out after a short delay; a new progress event resets it.
- `log(msg, level, data?)` — `level` must be `'info' | 'warn' | 'error'`;
  a two-arg call `log(msg)` defaults to `'info'`.
- Emitted event carries optional `source` for Phase 5 worker segmentation.
- Log panel renders the level with a token color and, when `data` is
  present, an expandable JSON-tree child (reuse the Phase 3 `output`
  renderer).

### `invoke` suite

Implemented in the Tauri backend as Rust commands; the runtime shim
exposes a single awaitable `invoke(name, args)` that:

1. Emits `{ type: 'invoke', fn, args, callId }`.
2. Awaits a matching `{ type: 'invoke:result', callId, result }` from stdin.
3. Rejects if the backend returns `{ callId, error }`.

Backend implementations:

- **filePicker** — Tauri dialog plugin. `mode: 'directory' | 'file'`;
  `filter` string glob. Returns absolute path(s).
- **confirm** — modal overlay with message + OK/Cancel. Always resolves
  to `{ confirmed: boolean }`.
- **prompt** — modal with message + text input. Resolves to
  `{ confirmed, value }` (`value` is `undefined` on cancel).
- **notification** — native OS notification. `level` maps to token color
  where the OS supports it.
- **openExternal** — `url` opened via OS shell; `newWindow: true` hints
  the OS where supported (no-op otherwise).
- **clipboard** — `op: 'read'` returns the string; `op: 'write'` requires
  `text`.

All resolve with an **object** (never a bare primitive) except
`clipboard({ op: 'read' })`, which returns the clipboard text directly per
the design example.

### `invokeStream`

- Shim exposes `invokeStream(name, args)` as an async iterator.
- Emits `{ type: 'invoke', fn, args, callId, stream: true }`.
- Backend dispatches to a streaming variant of the named target; each
  chunk sent back as
  `{ type: 'invoke:stream', callId, chunk, final: boolean }`.
- Iterator yields chunks; a `final: true` terminates the loop; an error
  event rejects.
- `filePicker` gains a streaming `{ recursive: true }` mode that emits
  `{ count, files }` progress chunks during directory traversal.
- Documented gap: no high-watermark backpressure — fast producers may
  queue chunks in memory. Tracked as a Phase 6 polish item.

### Cancellation signal

- Runtime shim constructs an `AbortController` at startup; exposes
  `signal` as `controller.signal`.
- The controller aborts when any of the following arrive from the
  backend on stdin:
  1. `{ type: 'cancel', reason? }` (user-initiated).
  2. `{ type: 'cancel', reason: 'timeout' }` (hard timeout fired).
  3. `{ type: 'cancel', reason: 'window-close' }`.
- Hard timeout: configured as `export const timeoutMs` on the script
  (defaults to Aperture's built-in); Tauri-side timer fires cancel then
  starts a 5s SIGKILL ladder.
- Window close: shell sends `cancel` with reason `window-close`; waits
  for `onExit` to resolve (signaled by a `{ type: 'result' }` from the
  shim's auto-wrapped onExit); then SIGKILL after 5s.
- All open invokes and invokeStreams reject with an AbortError when the
  signal fires.
- Phase 5's workers key off this same signal to auto-terminate; Phase 4
  exposes a subscribe hook on the shim's controller for the worker
  harness to use.

### Callback dispatcher

- GUI emits `{ type: 'call', fn, args, callId }` from the backend via
  whatever element triggered it.
- Shim resolves `fn` against the script's named exports (captured in the
  Phase 2 `ScriptManifest`). If missing, emit an `error` event back and
  surface in the log panel.
- Invokes the export with `(args, runtime)`.
- If `meta[fn]?.returnsInto` is set, `await`s the return value and calls
  `runtime.state.set(meta[fn].returnsInto, result)`; this flows through
  normal watch/persist/stream rules.
- Uncaught exceptions from a callback route to the death screen (Phase 1
  already catches process-level errors; this phase adds a clean rethrow
  path from async callbacks so async stack traces land verbatim).

### Formatters pipeline

- Built-in set implemented as a constant map: `bytes`, `ms`, `date`,
  `number`, `percent`, `relative`.
- `formatters` export merged on top; custom wins on key collision.
- Resolver `applyFormatter(name, value, context)`:
  - Unknown name → log a warn and return raw value.
  - Sync function returning string → return directly.
  - Sync function returning `{ text, color }` → render with `color`
    resolved via the Phase 3 color helper.
  - Async function → return a special placeholder marker; schedule the
    promise; on resolution, update the memo cache keyed by a stable
    hash of `(name, serialized value, serialized context)` and
    trigger a re-render for dependents.
- The label/badge/table-cell code paths in Phase 3 (and Phase 5) read
  formatted values through this resolver.
- Shimmer placeholder uses a subtle opacity animation on the existing
  element rather than swapping to a skeleton.

### onExit wiring

- Shim auto-registers an internal wrapper that, when signaled, invokes
  the user's `onExit(runtime)` if present, then emits a sentinel so the
  shell knows to release the grace timer.
- If onExit throws, the error routes to the death screen like any other
  callback.

## Acceptance Criteria

1. `await invoke('filePicker', { mode: 'directory' })` returns an
   absolute path string and can be cancelled (backend modal dismissal
   resolves with a documented shape — design says invoke callers handle
   cancel via `confirmed === false` where applicable).
2. `await invoke('confirm', ...)` always returns `{ confirmed }`.
   `await invoke('prompt', ...)` always returns `{ confirmed, value }`
   with `value === undefined` on cancel.
3. `invokeStream('filePicker', { mode: 'directory', recursive: true })`
   yields progressive `{ count }` chunks to a `for await` consumer.
4. `runtime.log('hi', 'warn', { code: 500 })` shows up in the log panel
   colored as warn with an expandable JSON blob.
5. `runtime.progress(0.5, 'half')` moves the top-level progress bar to
   50%.
6. Clicking a `button` with `onClick: 'runThing'` and
   `meta.runThing = { returnsInto: 'result' }`:
   - Dispatches `runThing({}, runtime)`.
   - The return value appears in `state.result` after the call.
   - `state.watch('result', …)` fires exactly once per call.
7. Closing the window causes:
   - `runtime.signal.aborted === true` inside the running callback.
   - `onExit` runs within the 5s grace.
   - Process exits; no SIGKILL unless onExit hangs.
8. A script whose callback throws lands on the death screen with the
   original stack trace (not wrapped by the dispatcher).
9. A `label` bound to a numeric key with `format: 'bytes'` renders
   human-readable units; the same with a custom formatter (e.g.
   `statusLabel`) renders using the script's definition; a custom
   `bytes` formatter overrides the built-in.
10. An async formatter applied in a label produces a shimmer until
    resolution, then shows the resolved text; a subsequent render with
    the same value is synchronous (memo hit).

## Dependencies

- Phase 1: IPC, lifecycle skeleton, death screen.
- Phase 2: state writes (for `returnsInto` and watchers); script
  manifest extraction for `meta` + `formatters`.
- Phase 3: log panel scaffolding; color helper; `format` prop resolver
  hook; modal overlay primitive (reused for confirm/prompt).

## Risks & Open Questions

- **Design open question — `invokeStream` backpressure.** Phase 4
  ships without policy. Track real-world usage in Phase 5's worker
  scripts; if OOM symptoms appear, add a high-watermark pause or
  drop-oldest knob in Phase 6.
- **Async formatter cache growth.** Unbounded memo could balloon on a
  table of thousands of unique values. Ship a simple LRU (e.g.,
  1000 entries per formatter name) by default; surface as configurable
  if it bites.
- **Cancellation races.** User cancels while a callback awaits an
  invoke. The invoke rejects with AbortError; the callback must not
  crash the child if it propagates. The dispatcher catches AbortError
  and logs it at `warn` without routing to the death screen when
  `signal.aborted` is true. Verify this rule end-to-end.
- **`export const timeoutMs`** is not in design.md verbatim — the
  spec says "configurable per-script" without naming the knob. Propose
  this export name and raise in the Phase 4 design review; fall back
  to a global default if scope-cut.
