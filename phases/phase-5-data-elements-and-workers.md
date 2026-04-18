# Phase 5 — Advanced Data Elements & Workers

> Ship the rest of the element registry — `table`, `tree`, `chart`,
> `timeline` — with virtualization, nested cells, and live updates.
> Alongside, deliver the worker-thread subsystem so scripts can offload
> long-running work without closing over outer scope.

## Goal

Scripts can render rich data views at scale (10k+ row tables, 5k-point
charts, 500-entry timelines) that stream live updates from one or more
concurrent workers. Workers are self-contained function literals that can
read live state via `await get(key)`, emit progress/state events, return
a value that becomes the worker's promise resolution, and are
automatically terminated when cancellation fires.

## Scope (in)

From `design.md`:

- §"Element Registry" / Data subsection:
  - `table` — virtualized; `rowKey`, `selectable`, `selectedBind`,
    `maxEntries` FIFO; `bulkActions` floating bar; column `cell` slots
    that can contain any element including nested `table`, `chart`,
    `tree`, `timeline`; client-side sort and filter over the full bound
    array; `rowDataAs`, `selectedAs`; `disabledWhen` / `visibleWhen`
    inside cell context resolves `bind` against the row object.
  - `tree` — `nodeKey`, `labelKey`, `iconKey`, `childrenKey`;
    `selectable`, `selectedBind`; `defaultExpanded` (all / none / id
    list); `onSelect`, `onExpand`; `actions` with `nodeDataAs`.
  - `chart` — `chartType: line | area | bar | pie | scatter` plus
    `donut: true` for pie; `xKey`, `series` with semantic-or-hex colors;
    `height`, `smooth`, `stacked`, `grid`, `tooltip`, `legend`,
    `maxEntries` FIFO; via Recharts.
  - `timeline` — append-only; virtualized; `eventKey`, `autoScroll`,
    `filterLevels`, `timestampFormat: relative | absolute | elapsed`;
    `onClick` + `eventDataAs`; `logTarget` (state key) that
    `runtime.log()` auto-appends to; `maxEntries` caps both DOM and
    bound state array FIFO.
- §"Worker Threads" — full subsystem:
  - `runtime.createWorker(fn, { name })`.
  - `fn.toString()` serialization; inline bootstrap (`workerData`,
    `parentPort`, `emit`, `get`).
  - Self-contained constraint; outer-scope access is a **warning only**
    under `aperture dev` / `aperture validate`; never a runtime failure.
  - Flat hierarchy — workers cannot spawn workers.
  - Unlimited concurrent workers at the top level.
  - Worker identity via caller-supplied `{ name }`; every emitted event
    carries `source: name`. Log panel segments by source.
  - `worker.on(event, handler)` subscription surface.
  - `worker.run(data)` returns a promise that resolves to the worker's
    return value and rejects on throw.
  - Worker state access: `await get(key)` round-trips through `state:get`
    / `state:get:reply` via the parent.
  - Automatic worker termination when `runtime.signal` fires.

## Scope (out)

- Static-analysis surface for workers (warnings on unresolved
  outer-scope identifiers) — lives in the CLI; implemented in Phase 6's
  `aperture dev` / `aperture validate` work items.
- Design open question on worker memory limits — **not** addressed;
  documented as a known gap.

## Work Items

### `table`

- Virtualized list (e.g. `react-virtuoso` or a hand-rolled windowing
  layer sharing core with `timeline`). Only the visible rows render;
  scrolling stays smooth to 10k+ rows.
- Client-side sort: columns declare `sortable`; the sort runs against
  the full bound array, not just visible rows.
- Client-side filter: optional `filter` prop on a column (predicate or
  text input) — design doc is silent on the prop name; provisional
  `filter: true` enables a header search field and routes through a
  single text matcher across filterable columns.
- Cell content: each column either declares a `format` OR a `cell`
  descriptor (any element). The cell's `bind` resolves against the
  row object (via the Phase 3 row-scoped resolver), and `rowDataAs` on
  any button inside the cell injects `{ [name]: rowObject }` into the
  callback.
- `selectedBind` tracks row IDs; `selectable: true` adds a checkbox
  column.
- `bulkActions` float as a bottom-docked bar when `selectedBind` is
  non-empty; clicking dispatches the callback with
  `{ [selectedAs]: rows[] }`.
- `maxEntries` is enforced at the **state store** level: a watcher on
  the bound key trims FIFO when the array exceeds the cap. This is the
  canonical FIFO behavior reused by `chart` and `timeline`; extract a
  shared helper.

### `tree`

- Indented rows keyed by `nodeKey`; children rendered via
  `childrenKey`.
- Icon per node via Lucide string name in `iconKey`.
- `defaultExpanded`:
  - `'all'` — expand every node on first render.
  - `'none'` — collapse all.
  - `[ids]` — expand exactly those IDs.
- `onSelect` + `onExpand` dispatch callbacks with `{ node }` via the
  Phase 4 dispatcher.
- Per-node `actions` render as icon buttons next to the label on hover;
  `nodeDataAs` injects the node into the callback args.
- Virtualization for large trees: windowed rendering on the flattened
  visible list.

### `chart`

- Wrap Recharts.
- Supported types:
  - `line`, `area` — `xKey` on the x-axis; each series = one line/area.
  - `bar` — supports `stacked: true`.
  - `scatter` — `xKey` on x-axis, one series per y-key.
  - `pie` — uses `nameKey` and `valueKey`; `donut: true` renders as
    donut.
- Semantic-or-hex colors via Phase 3's color helper.
- `height`, `smooth`, `grid`, `tooltip`, `legend` map to Recharts props.
- `maxEntries` trims the bound array FIFO on writes (shared helper from
  `table`).
- Live updates: any state write to the bound key triggers a re-render;
  Recharts handles the animation.

### `timeline`

- Virtualized append-only list; shares the windowing core with `table`.
- Event shape matches the design:
  `{ id, timestamp, level, message, detail?, data?, source? }`.
- `filterLevels: true` renders a row of color-coded level pills that
  toggle visibility.
- `timestampFormat`:
  - `'relative'` — "3s ago", refreshed every second for visible rows.
  - `'absolute'` — locale-formatted ISO string.
  - `'elapsed'` — time since the first event in the list.
- `autoScroll: true` pins to the latest event unless the user scrolls
  up; an auto-hide "jump to latest" button appears otherwise.
- `logTarget: '<key>'` — registers a hook on `runtime.log` so every log
  call also appends an event object to `state[key]`. This is the only
  supported form; the `true`-shorthand is explicitly rejected (design
  doc drops it).
- `maxEntries` caps BOTH the DOM window and the bound array FIFO via
  the shared helper.
- `onClick` with `eventDataAs` dispatches a callback for an event row
  (useful for expanding details in a side panel).

### Worker subsystem

#### API

- `runtime.createWorker(fn, { name })` returns:
  ```ts
  interface Worker {
    run(data: unknown): Promise<unknown>;
    on(event: string, handler: (data: unknown) => void): () => void;
  }
  ```
- Flat hierarchy guard: inside a worker, the shim does NOT expose
  `createWorker` — attempting to use it throws immediately.

#### Bootstrap generation

- On `createWorker`, the shim:
  1. Calls `fn.toString()`.
  2. Concatenates a fixed bootstrap preamble that imports
     `worker_threads`, sets up `emit`, `get`, the pending-reply map,
     and the done/error signaling.
  3. Writes the resulting source to a temp `.mjs` file under
     `~/.aperture/logs/worker-tmp/` (for debuggability) and spawns a
     Node `Worker` pointed at it, passing `workerData` = `{ __name,
     userData }`.
  4. Cleans the temp file on worker exit.
- The bootstrap matches the design-doc listing:
  - `emit(event, data)` → `parentPort.postMessage({ type: event, data,
    source: name })`.
  - `get(key)` → posts `{ type: 'state:get', key, callId }`, awaits
    `state:get:reply`.
  - Done/error sentinels (`__done__`, `__error__`).

#### Parent-side plumbing

- The parent shim listens on the `Worker`'s message channel:
  - `progress` / `state:set` / `log` / any arbitrary event → fanned out
    to `worker.on(event, …)` subscribers AND bubbled to the main
    runtime's event emitter (so `state:set` from a worker goes through
    the same store and broadcasts to the GUI).
  - `state:get` → parent reads `runtime.state.get(key)` and posts a
    `state:get:reply`.
  - `__done__` → resolves `run()` with the payload.
  - `__error__` → rejects `run()` with a reconstructed Error carrying
    the serialized stack.
- Every outbound event from the parent's IPC stamps `source: name` when
  it originated from a worker, so the Phase 3 log panel can filter by
  worker.

#### Cancellation

- Phase 4's `AbortController` exposes a subscribe hook; the worker
  harness registers a callback that, on abort, calls `worker.terminate()`
  for every live worker.
- Any `run()` promise pending at that moment rejects with
  `new DOMException('Aborted', 'AbortError')`.
- Workers get no chance to clean up on abort — design is clear that
  termination is hard and scripts cannot intercept. Document this.

#### Outer-scope check (preview hook)

- The shim's `createWorker` has an injection seam where a static
  analyzer can walk `fn.toString()` and emit warnings. Phase 5 ships
  the seam and a trivial "always-off" analyzer; Phase 6's
  `aperture dev` / `aperture validate` plug in the real analysis.

### Log panel integration

- The Phase 3 log panel grows a **source filter** — a dropdown showing
  every `source` value seen on recent events, plus a "main" entry.
- Timeline elements using `logTarget` also respect per-source filtering
  via the same mechanism.

## Acceptance Criteria

1. A `table` bound to a 10,000-row state array renders interactively
   (scroll, sort, select) without visible frame drops.
2. A column with an inline `cell: { type: 'table', … }` renders a
   nested table in every row; `rowDataAs: 'file'` on a button inside
   a cell dispatches the callback with `{ file: rowObject }`.
3. `maxEntries: 1000` on a `table` keeps the bound array ≤1000 when
   upstream code pushes more; oldest rows drop FIFO.
4. A `tree` with `defaultExpanded: 'all'` renders every level on
   first mount; `onSelect` fires on click with `{ node }`.
5. A `chart` with `chartType: 'line'` and a live-appending state key
   animates new points in real time and prunes to `maxEntries`.
6. A `pie` chart with `donut: true` renders correctly with `nameKey`
   and `valueKey`.
7. A `timeline` with `logTarget: 'events'` auto-appends every
   `runtime.log(...)` call as a properly shaped event; level filter
   pills hide entries of unchecked levels.
8. `createWorker(fn, { name: 'scanner' })` spawns, runs the function
   against a provided `data` argument, and resolves `run()` with the
   function's return value.
9. Inside the worker, `await get('threshold')` round-trips through
   the parent and returns the live value after a main-thread mutation.
10. `emit('state:set', { key: 'currentFile', value: '…' })` from a
    worker updates `state.currentFile` on the main side; GUI bindings
    react.
11. Two concurrent workers with different `name`s both emit events
    tagged `source: <name>`; the log panel's source filter segments
    them cleanly.
12. Cancelling mid-run (close window, click a cancel button, or trip
    the timeout) terminates all live workers and rejects their
    pending `run()` promises with AbortError.
13. Attempting `runtime.createWorker` inside a worker throws with a
    clear error (flat hierarchy guard).

## Dependencies

- Phase 1 (IPC, process host).
- Phase 2 (state store, watchers, cache-key derivation for temp
  paths).
- Phase 3 (renderer core, color helper, predicate evaluator,
  row-scoped resolver stub, log panel, element registry).
- Phase 4 (callback dispatcher + `meta.returnsInto`, cancellation
  signal, log/progress events, formatters pipeline).

## Risks & Open Questions

- **Shared FIFO helper.** The `maxEntries` behavior lives in three
  elements; extract once, test once. Interactions with `.stream()`
  keys and GUI-origin writes need a deliberate ordering: trim AFTER
  apply, emit the post-trim size along with the write so bindings
  don't briefly see the oversized array.
- **Virtualization library choice.** Candidates: `react-virtuoso`,
  `@tanstack/react-virtual`. Prefer whichever supports variable-height
  rows and nested virtualization (cells containing charts/tables)
  without measurement bugs. Spike in the first week of Phase 5.
- **Recharts bundle weight.** Pulls in D3; on the order of 150 KB
  gzipped. Acceptable for desktop; monitor cold-start time and
  revisit if it inflates the binary beyond target.
- **Design open question — worker memory limits.** Not addressed.
  If a real-world script OOMs a worker, add
  `createWorker(fn, { maxMemoryMB })` in a post-v1 patch.
- **Temp file for worker source.** Writing `fn.toString()` to disk
  simplifies stack traces and debugging but requires cleanup on
  crash. Ring-buffer the `~/.aperture/logs/worker-tmp/` directory
  to at most N files so a crash loop doesn't leak disk.
