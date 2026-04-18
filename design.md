# Aperture Design Specification v2

> A GUI-native `.mjs` script runner. Define a script, get a GUI for free.

---

## What It Is

Aperture is a standalone OSS tool with two surfaces:

- **CLI** — developer tooling for authoring and working with Aperture scripts
- **Binary** — invoked with a `.mjs` script and working directory as arguments; launches a GUI runtime for that script

Aperture has no knowledge of Kepler or any other system. It is a general-purpose tool. Kepler is one consumer of it.

**Design constraint:** Scripts are expected to be produced primarily by LLMs. DX favors simple, predictable contracts, structured diagnostic output, and no exotic syntax.

---

## Mental Model

The script **is** the GUI definition. There is no "run button" concept at the core. The script declares state, layout, and behavior. Aperture renders it. Everything is event-driven from `onLoad` forward.

```
ui + state → rendered GUI → user interacts → callbacks → state mutations → GUI reacts
```

---

## Platform Support (v1)

- macOS (x86_64)
- Windows (x86_64)
- Linux (x86_64)

---

## CLI

Developer-facing. Used when building and iterating on scripts.

| Command | Purpose |
|---|---|
| `aperture new <name>` | Scaffold: commented skeleton with one state key, one button, one callback |
| `aperture dev <script.mjs>` | Run in dev mode — verbose output, worker static analysis enabled |
| `aperture validate <script.mjs>` | Check schema, deps, exports. Emits **structured JSON always**: `{ line, column, code, message, hint }` per issue |
| `aperture run <script.mjs>` | Headless execution — requires a `headless` export as the entry point |
| `aperture docs` | Emits an LLM-optimized markdown reference of the element registry, runtime API, and script contract |

> Hot reload is explicitly out of scope for v1. The death screen provides a "Reload Script" button for manual re-run.

---

## Binary / GUI Runtime

```bash
aperture <script-source> <working-dir>

# Local path
aperture ./scan-deps.mjs /home/justin/projects/kepler

# Remote URL
aperture https://s3.amazonaws.com/bucket/scan-deps.mjs?X-Amz-... /home/justin/projects/kepler
```

- `<script-source>` is treated as a URL if it begins with `http://` or `https://`, otherwise as a local path
- `<working-dir>` sets the `cwd` for script execution
- **Trust model:** any URL is accepted. Running arbitrary scripts from arbitrary sources is the user's problem. No signature verification, no allowlist.
- **Multi-instance policy:** one instance per canonical script path. A second launch refuses with a user-visible error and focuses the existing window.

### Startup Flow

```
peek script source → check version against cache (semver-aware)
  ├── cache hit (compatible version)  → render GUI immediately
  └── cache miss / major|minor change →
        show install/update screen (indeterminate progress bar)
          → download/read full script
          → install dependencies (bun)
          → render GUI
```

Install/update screen strings:
- `"Installing dependencies…"` on first run
- `"Updating to vX.Y.Z…"` on version change

### Offline Mode

`--offline` flag skips all version/network checks and runs whatever is cached. Fails cleanly if the script is not in cache.

---

## GUI Framework

**React + Vite** inside **Tauri**.

**Dark theme only** in v1. Color system accepts **any hex string or semantic name** anywhere a color is expected. Semantic tokens: `success | danger | warning | info | neutral`.

Component library: **React Bits** for polished primitives. Icon set: **Lucide** (referenced by name string in UI definitions).

---

## Script Contract

A valid Aperture script exports the following:

```js
// @aperture-version 2.0.0

import { z } from 'zod'

export const deps = ['zod', 'glob@^10.0.0']    // auto-installed before execution via bun

export const env = ['MY_API_KEY']              // env whitelist; user approves on first run

export const window = {                        // window configuration
  width: 1000,
  height: 720,
  resizable: true,
}

export const schema = z.object({})             // launch-time params — validated, passed to onLoad

export const state  = z.object({})             // live reactive state — bidirectional

export const ui = {}                           // declarative element tree (object OR function)

export const formatters = {}                   // optional custom formatters (sync or async)

export const meta = {                          // callback metadata — optional
  startScan: { returnsInto: 'results' },
}

export async function onLoad(params, runtime) {}
export async function onExit(runtime) {}
export async function headless(params, runtime) {}   // required only if `aperture run` is used

// Named exports = GUI-callable callbacks
export async function myCallback(args, runtime) {}
```

### `// @aperture-version` and Cache Invalidation

Declares the script version. Cache is keyed by `(canonical source, major.minor)`:

- **Patch bumps** (2.0.0 → 2.0.1) reuse the cache
- **Minor / major bumps** invalidate the cache and trigger a fresh dep install
- Scripts without the version comment are **never cached**

For remote URLs the canonical source strips signing parameters (e.g. `X-Amz-*`) so signed URLs remain stable cache keys.

### Dependencies

Entries are bare names or `name@semver` strings. Bare names resolve to latest on first install.

```js
export const deps = ['zod', 'glob@^10.0.0', '@aws-sdk/client-s3@3.500.0']
```

Installed via **bun** into a shared global cache at `~/.aperture/deps/`.

---

## `schema` vs `state`

|  | `schema` | `state` |
|---|---|---|
| **When** | Launch-time params | Live runtime values |
| **Source** | CLI flags + URL query (merged) | Script + user interaction |
| **Validated** | Yes (zod, at launch) | **No runtime validation** — schema is a type hint only |
| **Bidirectional** | Partial — see below | Yes |
| **Drives UI** | Via `from: 'schema'` binding | Direct `bind` |
| **Persisted** | No | Opt-in per key: `z.string().persist()` |

### Param Wire Format

CLI flags and URL query params are merged. **CLI wins on collision.** Complex params are JSON-stringified per key.

```bash
# URL query
aperture https://.../scan.mjs?targetDir=./src&dryRun=true <cwd>

# CLI flags
aperture ./scan.mjs <cwd> --targetDir ./src --dryRun true

# Complex values
aperture ./scan.mjs <cwd> --filters='["*.js","*.ts"]'
```

### Schema Params at Runtime

Inputs bound with `from: 'schema'` remain editable after launch. Edits go through normal `state.set` and also update the schema-backed key. However, **`onLoad` always sees the frozen launch-time snapshot** via `runtime.params`. Callbacks can read either:

- `runtime.params.targetDir` — frozen launch value
- `runtime.state.get('targetDir')` — live value (post user edits)

### State Write Conflicts

When the script and GUI write the same key in the same tick, **GUI wins for user-editable keys** (those bound to `input`, `number`, `slider`, `select`, `checkbox`, `textarea`, `file`). Script writes win for all other keys.

---

## Communication Architecture

Scripts run in a child process. All communication is **NDJSON over stdio**. The Tauri backend owns both pipes, parses JSON lines, and forwards to/from the React frontend via Tauri's event system. Stderr is captured separately as raw log output.

```
[script child process]
  stdout (NDJSON) → [Tauri backend parser] → tauri::emit() → [React frontend]
  stdin  (NDJSON) ← [Tauri backend]        ← tauri::listen() ← [React frontend]
  stderr (raw)    → [Tauri backend]         → log panel
```

**No per-frame size cap.** Backpressure is handled by OS pipe semantics — a very large single `state:set` value may stall the script until drained. Scripts that expect large values should use the streaming opt-in (see State API).

### Event Envelope — Script → GUI (stdout)

```ts
type ScriptEvent =
  | { type: 'progress';        value: number; label?: string }
  | { type: 'log';             level: 'info'|'warn'|'error'; message: string; data?: unknown; source?: string }
  | { type: 'state:set';       key: string; value: unknown }
  | { type: 'state:set:chunk'; key: string; chunk: string; final: boolean }    // streaming keys
  | { type: 'state:get';       key: string; callId: string }                   // worker state reads
  | { type: 'invoke';          fn: string; args: unknown; callId: string; stream?: boolean }
  | { type: 'result';          data: unknown }
  | { type: 'error';           message: string; stack?: string }
```

### Event Envelope — GUI → Script (stdin)

```ts
type GUIEvent =
  | { type: 'state:set';       key: string; value: unknown }
  | { type: 'state:changed';   key: string; value: unknown }                    // coalesced ~16ms per key
  | { type: 'state:get:reply'; callId: string; value: unknown }
  | { type: 'invoke:result';   callId: string; result: unknown }
  | { type: 'invoke:stream';   callId: string; chunk: unknown; final: boolean }
  | { type: 'call';            fn: string; args: unknown; callId: string }
  | { type: 'cancel';          reason?: string }                                // triggers AbortSignal
```

---

## The Runtime Module

Scripts import a virtual module shimmed by the Aperture runtime before execution. No globals — just an import.

```js
import {
  progress,       // emit a progress value
  log,            // emit a structured log line
  state,          // bidirectional reactive state
  invoke,         // unary native call (awaitable)
  invokeStream,   // streaming native call (async iterator)
  on,             // listen for GUI-initiated events
  createWorker,   // spawn a named worker thread
  params,         // frozen launch-time params snapshot
  signal,         // AbortSignal fired on cancel/timeout/window close
} from 'aperture:runtime'
```

`runtime` is a stable object reference across the lifetime of the child process — the same `runtime.state`, `runtime.signal`, and `runtime.params` are handed to every callback.

### `state` API

```js
state.set('key', value)                          // write — broadcasts to GUI
state.get('key')                                 // read current value
state.setIn(['files', id, 'status'], 'done')     // surgical nested mutation
state.push('events', newItem)                    // append to array

// Reactivity — fires on ALL writes, any origin (script OR GUI)
const off = state.watch('key', (value) => { ... })   // returns unsubscribe fn
off()                                                 // stop listening

await state.persist()                            // save `.persist()`-flagged keys (keyed by version)
```

#### Watch Semantics

- Triggered by any write, any origin (symmetric).
- Handler may be async. Handlers for the **same key** run **serially** (queued). Handlers for different keys run in parallel.
- State updates from the GUI are coalesced to animation-frame / ~16ms windows per key before firing watchers.
- To avoid infinite loops, don't write to a key from within its own watcher. Aperture does not do cycle detection.
- `state.watch` is the **canonical reactivity primitive** — no declarative equivalent in `meta`.

#### Persistence Opt-In

Only keys flagged `.persist()` are saved by `state.persist()`:

```js
export const state = z.object({
  threshold: z.number().persist(),
  targetDir: z.string().persist(),
  events:    z.array(z.any()),      // not persisted
})
```

#### Streaming Opt-In (for large values)

```js
export const state = z.object({
  bigReport: z.any().stream(),      // serialized as chunked state:set:chunk events
})
```

### `invoke` — Built-in Native Calls

Calls a fixed set of Aperture-provided GUI functions. Awaitable — the script suspends until resolved.

```js
// filePicker
const dir  = await invoke('filePicker', { mode: 'directory' })
const file = await invoke('filePicker', { mode: 'file', filter: '*.json' })

// confirm / prompt — ALWAYS return an object
const { confirmed }        = await invoke('confirm', { message: 'Delete 40 files?' })
const { confirmed, value } = await invoke('prompt',  { message: 'Enter a name:' })
// On cancel: confirmed === false, value undefined

// notification
await invoke('notification', { title: 'Done', body: 'Scan complete', level: 'success' })

// openExternal
await invoke('openExternal', { url: 'https://example.com', newWindow: true })

// clipboard
const text = await invoke('clipboard', { op: 'read' })
await invoke('clipboard', { op: 'write', text: 'hello' })
```

**v1 invoke set:** `filePicker`, `confirm`, `prompt`, `notification`, `openExternal`, `clipboard`.

Scripts do not declare custom `invoke` targets — that role is covered by named callback exports wired to `ui` elements.

### `invokeStream` — Streaming Native Calls

For long-running invocations that produce partial results.

```js
for await (const chunk of invokeStream('filePicker', { mode: 'directory', recursive: true })) {
  log(`Found ${chunk.count} files so far...`)
}
```

### `progress` and `log`

```js
progress(0.68, 'Scanning file 68 of 100')
log('Something happened', 'warn')                         // simple
log('HTTP call failed', 'error', { status: 500, url })    // structured context via third arg
```

`runtime.log()` auto-appends to any `timeline` element whose `logTarget` matches its bound state key.

### `signal` — Cancellation

```js
export async function startScan(_, runtime) {
  runtime.state.set('scanning', true)
  try {
    for (const file of files) {
      if (runtime.signal.aborted) break
      await processFile(file)
    }
  } finally {
    runtime.state.set('scanning', false)
  }
}
```

The `AbortSignal` fires when:
- The user triggers a `cancel` callback (or an event wired to emit `cancel`)
- The hard timeout is breached (5s grace before SIGKILL)
- The window is closed (onExit runs; grace period before SIGKILL)

When the signal fires, **all active workers are automatically terminated.** Scripts do not need to manually plumb cancellation into workers.

---

## Worker Threads

Scripts are a single `.mjs` file — no imports of local files. Workers are self-contained function literals passed to `createWorker`. The shim serializes via `fn.toString()` and bootstraps an inline worker.

**Flat hierarchy — workers cannot spawn workers.** Unlimited concurrent workers at the top level.

**The constraint:** worker functions cannot close over outer scope. Everything they need must come through `data`.

**Static analysis** on the stringified function is **off by default**; enabled by `aperture dev` and `aperture validate`. When enabled, unresolved-outer-scope identifiers produce **warnings only** (never errors, never runtime failures).

```js
export async function startScan(_, runtime) {
  const worker = runtime.createWorker(
    async function({ data, emit, get }) {
      // Self-contained — no outer scope
      const { readdir } = await import('fs/promises')
      const files = await readdir(data.dir, { recursive: true })

      for (const [i, file] of files.entries()) {
        emit('progress', i / files.length)
        emit('state:set', { key: 'currentFile', value: file })

        // Workers can read live state via state:get
        const threshold = await get('threshold')
      }

      return { total: files.length }
    },
    { name: 'scanner' }    // identifies this worker in logs and events
  )

  worker.on('progress',   (v)             => runtime.state.set('progress', v))
  worker.on('state:set', ({ key, value }) => runtime.state.set(key, value))

  // Promise resolves with the worker's return value; rejects if it throws
  const result = await worker.run({ dir: runtime.state.get('targetDir') })
  runtime.state.set('results', result)
}
```

### Worker Identity

`{ name }` is **caller-supplied**. Every event emitted by that worker carries `source: 'scanner'` so logs from concurrent workers can be segmented in the GUI.

### Worker State Access

Workers get initial data via `data`. For live reads, they call `await get(key)`, which emits a `state:get` request back to the main thread and resumes when the reply arrives.

### Worker Bootstrap (generated by shim)

```js
import { workerData, parentPort } from 'worker_threads'
import { randomUUID } from 'crypto'

const name = workerData.__name
const emit = (event, data) => parentPort.postMessage({ type: event, data, source: name })

const pending = new Map()
parentPort.on('message', (msg) => {
  if (msg.type === 'state:get:reply' && pending.has(msg.callId)) {
    pending.get(msg.callId)(msg.value)
    pending.delete(msg.callId)
  }
})

const get = (key) => new Promise((resolve) => {
  const callId = randomUUID()
  pending.set(callId, resolve)
  parentPort.postMessage({ type: 'state:get', key, callId })
})

const fn = /* stringified user function */
try {
  const result = await fn({ data: workerData.userData, emit, get })
  parentPort.postMessage({ type: '__done__', result })
} catch (err) {
  parentPort.postMessage({ type: '__error__', message: err.message, stack: err.stack })
}
```

---

## Script Lifecycle

```
aperture <script> <cwd>
  → cache check (semver-aware)
  → dep install (if needed, via bun)
  → show full-window install spinner
  → launch GUI
  → blocking spinner overlay during onLoad
  → onLoad(params, runtime) resolves      ← params = validated schema result
  → GUI interactive, user interacts
  → callbacks dispatched on events
  → user closes window OR hard timeout
  → signal fires (AbortSignal abort)
  → onExit(runtime)                       ← Aperture holds window open; 5s grace
  → process exits
```

### Error Boundary

If `onLoad` or any callback throws an uncaught exception, **the process exits**. The GUI replaces its content with a **full-window death screen** showing:

- The error message
- The full stack trace
- A **Reload Script** button that re-runs the cache check and relaunches the script

This is the default and cannot be overridden. Scripts that need to recover from errors should catch them inside the callback and route to state/logs.

---

## UI Definition

The `ui` export is one of:

1. A declarative, serializable **object literal** tree
2. A **function** `(state, params) => tree` — called on every state change, must return the same shape

Callback references are **string names** — not function references. The shim resolves them to named exports at dispatch time.

```js
// Static
export const ui = {
  type: 'column',
  children: [
    { type: 'input',  label: 'Target Dir', bind: 'targetDir', from: 'schema' },
    { type: 'button', label: 'Scan',       onClick: 'startScan', disabledWhen: 'scanning' },
  ]
}

// Dynamic — useful for N-of-something rendering
export const ui = (state, params) => ({
  type: 'column',
  children: state.files.map(f => ({
    type: 'card',
    title: f.name,
    children: [{ type: 'code', text: f.preview, language: 'js' }]
  }))
})
```

### `visibleWhen` / `disabledWhen`

Available on **all elements** including layout. Three forms:

```js
visibleWhen: 'isAdvanced'                          // boolean state key
visibleWhen: { bind: 'mode',  value: 'expert' }    // equality
visibleWhen: { bind: 'count', gt: 0 }              // gt | lt | gte | lte | not
```

---

## Callback Conventions

All named exports become GUI-callable. The callback signature is always:

```js
export async function myCallback(args, runtime) { }
```

- `args` — object injected by the element (e.g. `{ file: rowObject }` for `rowDataAs: 'file'`; `{ files: rows[] }` for `selectedAs: 'files'`; `{}` for plain buttons)
- `runtime` — full runtime API (stable reference)

### `meta` — Callback Metadata

Optional companion export. Currently supports `returnsInto`: when the callback returns a value, Aperture writes it to the named state key.

```js
export const meta = {
  startScan:  { returnsInto: 'results' },
  loadConfig: { returnsInto: 'config' },
}

export async function startScan(_, runtime) {
  const data = await fetch(/* ... */).then(r => r.json())
  return data    // → written to state.results automatically
}
```

Watchers fire on these writes exactly like any other state mutation.

---

## Custom Formatters

Named export. Sync or async. Functions receive the raw value and the row/node context object.

```js
export const formatters = {
  // Sync, value → string
  severity: (value) => {
    const map = { 1: 'Low', 2: 'Medium', 3: 'High', 4: 'Critical' }
    return map[value] ?? 'Unknown'
  },

  // Sync, with row context
  sizeDelta: (value, row) => {
    const pct = ((value - row.baseline) / row.baseline * 100).toFixed(1)
    return `${value.toLocaleString()} bytes (${pct > 0 ? '+' : ''}${pct}%)`
  },

  // Rich output — text + color
  statusLabel: (value) => ({
    text:  value === 'ok' ? 'Healthy' : 'Degraded',
    color: value === 'ok' ? 'success' : 'danger',
  }),

  // Async — cells show a placeholder until resolved, then cache per-input
  reverseGeo: async ({ lat, lng }) => {
    const res = await fetch(`https://nominatim.../reverse?lat=${lat}&lon=${lng}`)
    const { display_name } = await res.json()
    return display_name
  },
}
```

Async formatter results are **memoized per-input**. Cells display a subtle placeholder shimmer until the first resolution lands.

**Built-in formatters:** `bytes`, `ms`, `date`, `number`, `percent`, `relative`
Custom formatters share the same namespace — custom wins on collision.

---

## Element Registry

### Inputs

| Element | Key Props |
|---|---|
| `input` | `bind`, `label`, `inputType` (text / email / password), `placeholder`, `shortcut` |
| `number` | `bind`, `label`, `min`, `max`, `step` |
| `textarea` | `bind`, `label`, `rows`, resizable |
| `select` | `bind`, `label`, `options` — array OR string state-key (e.g. `options: 'regions'`) |
| `checkbox` | `bind`, `label` |
| `slider` | `bind`, `label`, `min`, `max`, `step` |
| `button` | `label`, `onClick`, `variant` (primary / secondary / danger), `disabledWhen`, `visibleWhen`, `shortcut` |
| `file` | `bind`, `label`, `mode` (file / directory), `filter`, `store` |

**`file.store`** controls what lands in the bound state key:

- `'path'` (default) — absolute filepath string
- `'meta'` — `{ path, name, size, type }`
- `'contents'` — text (UTF-8) or base64 (binary)

### Display

| Element | Key Props |
|---|---|
| `label` | `bind` or `text`, `format` |
| `badge` | `bind`, `variants` map (value → color; semantic token or hex) |
| `progress` | `bind` (0–1), `indeterminate` boolean |
| `code` | `bind` or `text`, `language` |
| `output` | `bind` — JSON tree renderer, collapsible nodes |
| `stat` | `bind`, `label`, `delta` (state key), animated on change |
| `alert` | `bind` or `message`, `level` (info / warning / error / success) |
| `image` | `bind`, `srcType` (auto / path / url / base64), `fit`, `maxHeight`, `background`, `onClick` |

**`image` `srcType: 'auto'` rules (deterministic):**

- Starts with `data:` → `base64`
- Starts with `http://` or `https://` → `url`
- Otherwise → `path` (resolved relative to cwd if not absolute)

### Data

#### `table`

```js
{
  type: 'table',
  bind: 'files',
  rowKey: 'id',
  selectable: true,
  selectedBind: 'selectedFiles',
  maxEntries: 10000,          // caps the bound state array FIFO
  bulkActions: [
    { label: 'Process All', onClick: 'processSelected', selectedAs: 'files', variant: 'primary' },
    { label: 'Remove All',  onClick: 'removeSelected',  selectedAs: 'files', variant: 'danger' },
  ],
  columns: [
    { key: 'name', header: 'File', sortable: true },
    { key: 'size', header: 'Size', format: 'bytes', align: 'right' },
    {
      key: 'status',
      header: 'Status',
      cell: {
        type: 'badge',
        bind: 'status',
        variants: { pending: 'neutral', done: 'success', error: 'danger' }
      }
    },
    {
      key: '_actions',
      header: '',
      cell: {
        type: 'row',
        gap: 4,
        children: [
          { type: 'button', label: 'Process', variant: 'secondary', onClick: 'processFile',
            rowDataAs: 'file', disabledWhen: { bind: 'status', value: 'done' } },
          { type: 'button', label: 'Remove',  variant: 'danger',    onClick: 'removeFile',
            rowDataAs: 'file' },
        ]
      }
    }
  ]
}
```

- **Cells can contain any element**, including nested `table`, `chart`, `tree`, `timeline`.
- **Rendering is always virtualized.** Sort and filter are client-side on the full bound array.
- `rowDataAs` injects `{ [name]: rowObject }` as the `args` parameter of the callback.
- `disabledWhen` / `visibleWhen` inside a cell context resolve `bind` relative to the row object.
- `bulkActions` appear as a floating action bar when `selectedBind` has entries.
- `selectedAs` injects selected rows as `{ [name]: rows[] }` into the callback.
- `maxEntries` is a hard cap on the bound state array; older rows drop FIFO.

#### `tree`

```js
{
  type: 'tree',
  bind: 'fileTree',
  nodeKey: 'id',
  labelKey: 'name',
  iconKey: 'icon',               // Lucide icon name on each node
  childrenKey: 'children',
  selectable: true,
  selectedBind: 'selectedNode',
  defaultExpanded: 'all',        // all | none | [id, id, ...]
  onSelect: 'onNodeSelect',
  onExpand: 'onNodeExpand',
  actions: [
    { label: 'Open',   onClick: 'openNode',   nodeDataAs: 'node' },
    { label: 'Delete', onClick: 'deleteNode', nodeDataAs: 'node', variant: 'danger' },
  ]
}
```

Node shape:

```js
{
  id: 'src/components',
  name: 'components',
  icon: 'Folder',
  children: [
    { id: 'src/components/Button.tsx', name: 'Button.tsx', icon: 'File', children: [] }
  ]
}
```

#### `chart`

```js
// Line / area / bar / scatter
{
  type: 'chart',
  chartType: 'line',             // line | area | bar | pie | scatter
  bind: 'metrics',
  xKey: 'time',
  series: [
    { key: 'cpu',    label: 'CPU %',    color: 'info'    },     // semantic OR hex
    { key: 'memory', label: 'Memory %', color: '#f59e0b' },
  ],
  height: 240,
  smooth: true,
  stacked: false,
  grid: true,
  tooltip: true,
  legend: true,
  maxEntries: 5000,              // FIFO cap on the bound state array
}

// Pie / donut
{
  type: 'chart',
  chartType: 'pie',
  bind: 'distribution',
  nameKey: 'label',
  valueKey: 'count',
  donut: true,
}
```

Data is bound to a state key (array of objects). Append to the array from any callback or worker — the chart reacts live. Uses Recharts under the hood.

#### `timeline`

Append-only event stream. Virtualized rendering — older entries pruned from the DOM but retained in state up to `maxEntries`.

```js
{
  type: 'timeline',
  bind: 'events',
  eventKey: 'id',
  autoScroll: true,
  filterLevels: true,              // renders level filter pills
  timestampFormat: 'relative',     // relative | absolute | elapsed
  onClick: 'onEventClick',
  eventDataAs: 'event',
  logTarget: 'events',             // state key that runtime.log() auto-appends to
  maxEntries: 500,                 // caps BOTH DOM and bound state array (FIFO)
}
```

**`logTarget` is always a state key string.** The legacy `logTarget: true` form from earlier drafts is dropped.

Event shape:

```js
{
  id: crypto.randomUUID(),
  timestamp: new Date().toISOString(),
  level: 'info',                   // info | warn | error | success
  message: 'Job started',
  detail: 'Optional secondary text — expandable',
  data: { key: 'value' },          // optional collapsible JSON blob
  source: 'scanner',               // optional — worker name when applicable
}
```

### Layout

| Element | Key Props |
|---|---|
| `row` | `gap`, `align`, `justify`, `children` |
| `column` | `gap`, `align`, `children` |
| `card` | `title`, `children`, `padding`, `collapsible`, `footer`, `actions`, `variant` |
| `tabs` | `items: [{ label, children, visibleWhen?, keepAlive? }]` |
| `divider` | `label` (optional) |
| `scroll` | `maxHeight`, `children` |

#### `card` — full shape

```js
{
  type: 'card',
  title: 'Configuration',
  variant: 'info',                 // default | info | danger
  collapsible: true,
  padding: 16,
  children: [...],
  footer: [{ type: 'label', text: 'Last synced 5 min ago' }],
  actions: [
    { type: 'button', label: 'Save',  onClick: 'save',  variant: 'primary' },
    { type: 'button', label: 'Reset', onClick: 'reset' },
  ],
}
```

#### `tabs` + `visibleWhen` + `keepAlive`

```js
{
  type: 'tabs',
  items: [
    { label: 'Overview',  children: [...] },
    { label: 'Details',   children: [...], visibleWhen: 'isExpert' },
    { label: 'Heavy Viz', children: [...], keepAlive: true },
  ]
}
```

- Default behavior when `visibleWhen` evaluates false: **tab strip entry hidden AND children unmounted**.
- `keepAlive: true` opts the tab's children into staying mounted while the strip entry is hidden.

All layout elements accept `visibleWhen` and `disabledWhen`.

---

## Keyboard Shortcuts

**Built-in defaults:**

- `Enter` → primary button on active form/card
- `Esc` → cancel button (if present) else close modal dialogs
- `Cmd/Ctrl + R` → restart the script

**Per-element shortcuts** override defaults:

```js
{ type: 'button', label: 'Save',   onClick: 'save', shortcut: 'cmd+s' }
{ type: 'input',  label: 'Filter', bind: 'q',       shortcut: '/' }
```

---

## Window Configuration

```js
export const window = {
  width: 1000,
  height: 720,
  resizable: true,
  minWidth: 600,      // optional
  minHeight: 400,     // optional
  title: 'Scanner',   // defaults to script filename
}
```

User resizes are persisted per-script under `~/.aperture/windows/<cache-key>.json` and override script defaults on subsequent launches.

**One window per script, period.** No `runtime.openWindow` in v1. No `runtime.spawn(otherScript)` in v1 — script-to-script composition happens by the user launching multiple Aperture instances.

---

## Complete Element List

```
Inputs:   input, number, textarea, select, checkbox, slider, button, file
Display:  label, badge, progress, code, output, stat, alert, image
Data:     table, tree, chart, timeline
Layout:   row, column, card, tabs, divider, scroll
```

**28 elements total.**

---

## Execution Runtime Details

- Scripts run in a **child process**, not the Aperture process itself
- **Node runtime is bundled via Bun** — users do not need Node installed. Single-binary distribution.
- **Package manager is bun** — shared global cache at `~/.aperture/deps/`
- **One instance per canonical script path** — second launches refuse and focus existing window
- `cwd` is set to the `<working-dir>` argument
- **Hard timeout** with graceful cancellation: `AbortSignal` fires → 5s grace → SIGKILL. Configurable per-script.
- Stdout/stderr streamed to the GUI in real time — not buffered
- **Env vars are not inherited** by default. Scripts declare requirements via `export const env = [...]`; user approves on first run; approval persists per script.
- `aperture:runtime` is a virtual module — shimmed before execution, never on disk
- Child process uses `.mjs` only. **No TypeScript.** No local file imports.

### Filesystem Layout

All Aperture state lives under a single directory across all platforms:

```
~/.aperture/
├── config.json         # user settings, env approvals
├── deps/               # shared bun package cache
├── scripts/            # cached script sources (keyed by canonical source + major.minor)
├── state/              # persisted state per script
├── windows/            # window size/position per script
└── logs/               # stderr captures (ring-buffered)
```

---

## Debugging Model

Scripts are expected to be authored primarily by LLMs and iterated by reading output. The debugging strategy is deliberately log-centric:

- `console.log` inside callbacks and workers → stderr → Aperture log panel
- `runtime.log(msg, level, data)` → structured event with optional JSON context; appears in `timeline` elements and log panel
- `aperture validate <script.mjs>` → **structured JSON always**: `{ line, column, code, message, hint }` per issue, designed to be fed directly to an LLM auto-fix loop
- `aperture dev <script.mjs>` → enables worker static analysis, verbose NDJSON tracing, and a live protocol inspector

**No Node inspector integration in v1.** No breakpoints.

---

## LLM Authoring Support

```bash
aperture docs                          # full markdown reference to stdout
aperture docs --section elements       # element registry only
aperture docs --section runtime        # aperture:runtime API only
aperture validate my-script.mjs        # structured JSON tuned for LLM auto-fix
```

The `aperture docs` output is the canonical prompt-priming document for LLM script generation.

---

## Full Example Script

```js
// @aperture-version 1.0.0

import { z } from 'zod'

export const deps = ['zod', 'glob@^10.0.0']

export const window = { width: 900, height: 600, resizable: true, title: 'Dep Scanner' }

export const schema = z.object({
  targetDir: z.string().default('./src').describe('Root directory to scan'),
  dryRun:    z.boolean().default(true).describe('Preview without writing'),
})

export const state = z.object({
  status:      z.string().default('idle').persist(),
  progress:    z.number().default(0),
  currentFile: z.string().default(''),
  threshold:   z.number().default(50).persist(),
  scanning:    z.boolean().default(false),
  results:     z.any().default(null),
  events:      z.array(z.any()).default([]),
})

export const formatters = {
  statusLabel: (value) => ({
    text:  value === 'idle' ? 'Ready' : value,
    color: value === 'error' ? 'danger' : 'neutral',
  })
}

export const meta = {
  runScan: { returnsInto: 'results' },
}

export const ui = {
  type: 'column',
  children: [
    {
      type: 'card',
      title: 'Configuration',
      collapsible: true,
      actions: [
        { type: 'button', label: 'Reset', onClick: 'resetConfig' }
      ],
      children: [
        { type: 'input',    label: 'Target Directory', bind: 'targetDir', from: 'schema' },
        { type: 'slider',   label: 'Threshold',        bind: 'threshold', min: 0, max: 100 },
        { type: 'checkbox', label: 'Dry Run',          bind: 'dryRun',    from: 'schema' },
      ]
    },
    {
      type: 'row',
      gap: 8,
      children: [
        { type: 'button', label: 'Scan',   onClick: 'runScan', variant: 'primary',
          disabledWhen: 'scanning', shortcut: 'cmd+enter' },
        { type: 'button', label: 'Cancel', onClick: 'cancel',  variant: 'danger',
          visibleWhen: 'scanning', shortcut: 'esc' },
      ]
    },
    { type: 'progress', bind: 'progress', visibleWhen: 'scanning' },
    { type: 'label',    bind: 'status',   format: 'statusLabel' },
    { type: 'timeline', bind: 'events',   eventKey: 'id', autoScroll: true,
      filterLevels: true, logTarget: 'events', maxEntries: 500 },
    { type: 'output',   bind: 'results',  visibleWhen: 'results' },
  ]
}

export async function onLoad(params, runtime) {
  runtime.state.set('status', `Ready — targeting ${params.targetDir}`)

  // React to threshold changes — canonical reactivity pattern
  const off = runtime.state.watch('threshold', (v) => {
    runtime.log('Threshold updated', 'info', { threshold: v })
  })
  // off() when no longer needed; auto-cleaned on process exit regardless
}

export async function onExit(runtime) {
  await runtime.state.persist()
}

export async function runScan(_, runtime) {
  runtime.state.set('scanning', true)
  runtime.state.set('results', null)
  runtime.log('Scan started', 'info')

  const dir = runtime.state.get('targetDir')

  const worker = runtime.createWorker(
    async function({ data, emit }) {
      const { readdir } = await import('fs/promises')
      const files = await readdir(data.dir, { recursive: true })
      for (const [i, file] of files.entries()) {
        emit('progress', i / files.length)
        emit('state:set', { key: 'currentFile', value: file })
      }
      return { total: files.length }
    },
    { name: 'fileScanner' }
  )

  worker.on('progress',  (v)              => runtime.state.set('progress', v))
  worker.on('state:set', ({ key, value }) => runtime.state.set(key, value))

  try {
    const result = await worker.run({ dir })
    runtime.state.set('progress', 1)
    runtime.state.set('status', 'Done')
    runtime.log(`Completed — ${result.total} files`, 'info')
    return result    // → written to state.results via meta.runScan.returnsInto
  } catch (err) {
    if (runtime.signal.aborted) {
      runtime.log('Cancelled', 'warn')
      runtime.state.set('status', 'Cancelled')
      return null
    }
    throw err        // → death screen
  } finally {
    runtime.state.set('scanning', false)
  }
}

export async function cancel(_, runtime) {
  // Triggers the GUI cancel event which fires runtime.signal internally
  runtime.log('Cancel requested', 'warn')
}

export async function resetConfig(_, runtime) {
  runtime.state.set('targetDir', './src')
  runtime.state.set('threshold', 50)
}

// Required only if launched via `aperture run`
export async function headless(params, runtime) {
  await runScan({}, runtime)
  return runtime.state.get('results')
}
```

---

## Remaining Open Questions

- **Accessibility** — ARIA labels, screen reader support, focus management — deferred to post-v1.
- **GUI crash recovery** — if the Tauri side crashes (not the script), should we attempt to reattach to the still-running child, or kill and restart?
- **Worker memory limits** — currently unbounded. Add `createWorker(fn, { maxMemoryMB })` if real-world scripts OOM?
- **`invokeStream` backpressure** — async iterator consumers can lag behind producers. High-watermark pause, or drop-oldest policy?
- **Auto-derived labels** — when `label` is omitted, should Aperture derive one from `bind` ("targetDir" → "Target Dir")?
- **Schema param CLI conflict wording** — CLI-wins-on-collision is decided, but should we emit a warning log when a URL param is silently overridden?
