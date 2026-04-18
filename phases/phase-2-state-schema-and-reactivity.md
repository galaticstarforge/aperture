# Phase 2 — State, Schema & Reactivity

> Put the data model in place. Scripts declare schema and state with zod,
> write through `runtime.state`, subscribe via `watch`, persist
> selectively, and stream large values. This is the backbone every other
> runtime API and element binding relies on.

## Goal

A script can declare `schema` + `state`, receive validated launch params in
`onLoad`, read/write state from callbacks, and observe all writes through
`runtime.state.watch` — with GUI-origin writes coalesced, `.persist()` keys
surviving restarts, and `.stream()` keys transferred as chunks.

## Scope (in)

From `design.md`:

- §"Script Contract" — recognize and validate the full export surface: `deps`,
  `env`, `window`, `schema`, `state`, `ui`, `formatters`, `meta`. Only
  `schema` / `state` behavior is implemented end-to-end this phase;
  the others are parsed and stored so Phase 3+ can consume them without
  re-reading the file.
- §"`schema` vs `state`" — the full comparison table.
- §"Param Wire Format" — merge CLI flags with URL query params, CLI wins on
  collision, complex values JSON-parsed per key, pass merged object through
  `schema.safeParse`. Expose both `runtime.params` (frozen) and
  `runtime.state` access patterns.
- §"Schema Params at Runtime" — `from: 'schema'` inputs resolve against the
  state key of the same name and remain editable post-launch; `runtime.params`
  stays frozen to the launch-time validated snapshot.
- §"State Write Conflicts" — GUI wins in the same-tick contention rule for
  keys bound to `input|number|slider|select|checkbox|textarea|file`; script
  wins for every other key. (The element list is authoritative from
  design.md and is encoded as a runtime lookup, not hard-coded in tests.)
- §"The Runtime Module" / `state` API — `set`, `get`, `setIn`, `push`,
  `watch` (returns unsubscribe), `persist`.
- §"Watch Semantics" — async handlers allowed; same-key serial / cross-key
  parallel; ~16ms coalescing on GUI-origin writes per key; no cycle
  detection (documented contract).
- §"Persistence Opt-In" — extend zod with a `.persist()` marker chained on
  any schema; `state.persist()` writes only flagged keys, versioned by the
  script's `// @aperture-version` so a version bump starts fresh. Storage at
  `~/.aperture/state/<cache-key>.json`.
- §"Streaming Opt-In" — `.stream()` marker on a schema entry causes writes
  to that key to serialize as `state:set:chunk` events with a `final: true`
  sentinel; reassembly on the GUI side is transparent.

## Scope (out)

- Rendering state into UI elements (Phase 3) — Phase 2 verifies behavior
  through programmatic assertions and dev-console introspection.
- `runtime.invoke`, `progress`, `log` beyond the Phase 1 stubs (Phase 4).
- Workers reading/writing state via the `get(key)` round-trip (Phase 5).
- `meta.returnsInto` auto-writes (Phase 4 — keyed to callback dispatch).

## Work Items

### Script contract extraction

- Parse the script once via dynamic `import()` inside the child and cache
  the module record.
- Collect exports into a single `ScriptManifest` struct passed to downstream
  phases. Missing exports default appropriately (e.g. `ui = {}`).
- Enforce that `schema` and `state` are zod schemas (duck-type check on
  `_def`); fail loud on mismatch with a death-screen-friendly message.

### zod extensions

- Implement `.persist()` and `.stream()` as schema-level markers using zod's
  `describe`/`meta` facility (or a small symbol-keyed metadata sidecar) so
  they survive `.default()` / `.optional()` chaining.
- Traverse `state` schema once at load to build two key sets: persistKeys
  and streamKeys.

### Param merge & validation

- Build the launch-time params object:
  1. Start with URL query params (parsed from the script-source URL).
  2. Overlay CLI flags (positional key/value pairs after the two required
     args).
  3. Per-key: if the raw value looks like JSON (`[`/`{`/`"`/number/bool),
     attempt parse and fall back to the raw string.
- Run `schema.safeParse(merged)`. On failure, route to the death screen with
  the zod issue list rendered as structured lines.
- Freeze the result as `runtime.params`. Also seed `state` defaults with
  `state.parse({})` then overlay any schema-backed keys whose names also
  appear in state (that's how `from: 'schema'` inputs resolve).

### Reactive state store

Implement as a single in-child-process module exposed through the runtime
shim:

- Internal shape: `{ values, watchers, originStamps }`.
- `set(key, value)` — validates key exists on state schema in dev mode only;
  writes value; fires watchers for that key; emits `state:set` (or chunked
  variant for stream keys) to the GUI.
- `get(key)` — sync read.
- `setIn(path, value)` — structural clone of the intermediate nodes along
  the path, then broadcast the root key. No partial-path wire events in v1.
- `push(key, item)` — convenience wrapper on top of `setIn`.
- `watch(key, handler)` — returns unsubscribe; watchers for the same key run
  serially via a per-key promise chain; watchers for different keys run
  independently; async handlers supported.
- `persist()` — snapshot persistKeys, write to
  `~/.aperture/state/<cache-key>.json` atomically (write-temp-then-rename).

### GUI → script writes

- GUI emits `state:changed` events coalesced per key to at most one per
  ~16ms window (requestAnimationFrame-driven on the frontend; debounced by
  key).
- The backend forwards them verbatim into the child's stdin.
- The child applies the write through the same store module, then fires
  watchers. Origin stamp is recorded so the same-tick write-conflict rule
  can prefer GUI writes for user-editable keys.

### Write-conflict resolution

- Encode the "user-editable" element set from the design as a constant:
  `input`, `number`, `slider`, `select`, `checkbox`, `textarea`, `file`.
- On each state write, record which element (if any) the binding originated
  from. In the same microtask tick, if both origins touch a key, pick GUI
  when that key is currently bound to a user-editable element; script
  otherwise.
- Losses are logged at `debug` level with both values for diagnosability.

### Streaming state

- Writes to a `.stream()` key are chunked by the runtime into fixed-size
  (e.g. 64KB) `state:set:chunk` events with a `final: true` on the last
  chunk; key identity preserved across chunks.
- The Tauri backend buffers chunks and only forwards a reassembled
  `state:set` to the frontend on `final: true`. Partial buffers dropped if
  the key receives a new non-chunked write mid-stream (documented as
  last-writer-wins at the chunk-boundary level).

### Persistence

- `~/.aperture/state/<cache-key>.json` holds the last snapshot keyed by
  canonical source + `major.minor` from the version comment (Phase 6 locks
  in the cache-key format; Phase 2 uses a stub derivation to unblock).
- On startup, load the snapshot and overlay persistKeys on top of the
  defaults BEFORE `onLoad` runs, so `onLoad` sees the persisted values.

## Acceptance Criteria

1. A script with `schema = z.object({ targetDir: z.string() })` launched
   with `--targetDir ./src` receives `params.targetDir === './src'` in
   `onLoad`.
2. Same script with `?targetDir=./foo` in URL and `--targetDir ./bar` sees
   `./bar` (CLI wins).
3. Complex CLI value `--filters='["*.js"]'` parses to an array.
4. `schema.safeParse` failure renders a death screen listing zod issues.
5. `state.watch('x', h)` fires `h` on script-origin writes and on
   GUI-origin writes; same-key async handlers serialize; cross-key
   handlers do not block each other.
6. GUI rapid-fire writes to one key coalesce to ≤1 watcher invocation per
   ~16ms.
7. Writing a 10MB value to a `.stream()` key does not stall other events
   on stdio — stdout progress messages interleave with chunk frames. (At
   this phase, "does not stall" is verified by sending an interleaved
   `log` event from the script alongside a large state set.)
8. `state.persist()` then restart — persistKeys survive; non-persist keys
   reset to their schema defaults.
9. Bumping `// @aperture-version` minor discards the persisted snapshot and
   falls back to defaults.
10. A binding declared `from: 'schema'` in the manifest is readable at
    `runtime.state.get('targetDir')` and writes to it are visible through a
    `state.watch('targetDir', …)` registration.

## Dependencies

- Phase 1: NDJSON IPC, child-process host, virtual runtime shim,
  filesystem layout.

## Risks & Open Questions

- **zod marker portability.** `.persist()` / `.stream()` must survive
  composition with `.default()`, `.optional()`, `.describe()`. Prefer a
  small symbol-keyed sidecar map keyed on the schema instance over
  monkey-patching zod prototypes.
- **Coalescing cost.** Per-key rAF debouncing on the frontend is cheap for
  dozens of keys but may need an alternative batcher if scripts bind
  thousands of state keys to individual table cells — revisit in Phase 5
  once tables land.
- **Cache-key shape.** Phase 2 can proceed with a provisional derivation
  (`sha256(canonical_source) + '-' + majorMinor`), but Phase 6 must lock
  the exact format before the first public release, including how remote
  URL signing parameters are stripped.
- **Mid-stream collision** on a `.stream()` key (design open question in
  spirit) is resolved as "last writer replaces buffer"; revisit if a
  real-world script hits it.
