# Aperture

A GUI-native `.mjs` script runner. Define a script, get a GUI for free.

See [`design.md`](./design.md) for the full v2 design spec and
[`phases/`](./phases) for the phased implementation plan.

## Status — Phase 2 (State, Schema & Reactivity)

This branch layers the state + schema backbone from
[`phases/phase-2-state-schema-and-reactivity.md`](./phases/phase-2-state-schema-and-reactivity.md)
on top of the Phase 1 foundation:

- `runtime.state` is live — `set` / `get` / `setIn` / `push` / `watch` /
  `persist` all implemented in the child-process shim
- `schema` + `state` exports are extracted into a full `ScriptManifest`;
  zod is duck-typed so scripts can bring their own instance
- `.persist()` and `.stream()` extend `ZodType.prototype` via a symbol
  marker that walks inner wrappers — survives `.default()` / `.optional()`
  chaining in any order
- Launch-time params merge URL query + CLI flags (CLI wins on collision),
  auto-parse JSON-shaped strings, then run through `schema.safeParse`; on
  failure the shim emits a structured `error` event with the zod issue
  list for the death screen to render
- Watchers fire on any write, any origin; same-key handlers serialize via
  a per-key promise chain; cross-key handlers run in parallel; async
  handlers supported
- GUI-origin writes flow frontend → Tauri `send_to_child` → child stdin
  → store; writes are coalesced per key at `requestAnimationFrame` on the
  frontend so rapid-fire user input lands as ≤ 1 event per ~16ms
- Stream-flagged keys chunk into `state:set:chunk` frames of at most 64 KB
  each; the Tauri backend buffers and forwards a single reassembled
  `state-set` to the frontend on `final: true`
- Persistence writes `~/.aperture/state/<cache-key>.json` atomically;
  cache key is `sha256(canonical_path)[..16] + "-" + major.minor`. Scripts
  without `// @aperture-version` are never cached; a minor/major bump
  invalidates the snapshot on next launch
- State updates are mirrored to the frontend's shadow store; a dev handle
  (`window.__aperture`) exposes `setState` / `get` / `subscribe` so
  Phase 2 behavior is observable without any element renderer

The `invoke` suite, element rendering, workers, and the CLI sub-commands
(`new`/`dev`/`validate`/`run`/`docs`) remain in phases 3–6.

## Project Layout

```
aperture/
├── design.md                  # v2 design spec
├── phases/                    # phased implementation plan
├── src/                       # React frontend (Vite)
│   ├── main.tsx
│   ├── App.tsx
│   ├── types.ts               # mirrors wire protocol
│   └── screens/
├── src-tauri/                 # Rust backend (Tauri 2.x)
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   └── src/
│       ├── main.rs
│       ├── lib.rs
│       ├── cli.rs             # argv + URL/path dispatch
│       ├── fs_layout.rs       # ~/.aperture/ creation
│       ├── lock.rs            # multi-instance guard
│       ├── ndjson.rs          # incremental line framer
│       ├── child.rs           # child process host
│       └── events.rs          # wire-protocol types
├── runtime-shim/              # virtual `aperture:runtime` module
│   ├── loader.mjs             # --import hook
│   ├── hooks.mjs              # module.register resolver
│   ├── shim.mjs               # runtime API (state, progress, log, …)
│   ├── bootstrap.mjs          # per-child lifecycle driver
│   ├── schema-markers.mjs     # zod .persist() / .stream()
│   ├── state-store.mjs        # reactive state + watchers + chunked emit
│   ├── manifest.mjs           # ScriptManifest extraction
│   ├── params.mjs             # URL/CLI merge + safeParse
│   └── __tests__/             # `node --test` suite
└── examples/
    ├── empty.mjs              # Phase 1 AC #1
    ├── log.mjs                # Phase 1 AC #3
    ├── throw.mjs              # Phase 1 AC #2
    └── phase2-state.mjs       # Phase 2 schema + state + watch smoke script
```

## Building & Running (dev)

Phase 1 assumes a system `node` (≥ 20.6, for `module.register`) on `PATH`.
Phase 6 swaps in the bundled Bun-provided Node.

```bash
# install deps
npm install

# dev loop (starts vite + cargo tauri dev)
npm run tauri dev -- --no-watch -- ./examples/empty.mjs "$PWD"

# or a release build
npm run tauri build
./src-tauri/target/release/aperture ./examples/empty.mjs "$PWD"
```

Set `APERTURE_NODE=/path/to/node` to override the Node binary selection.

## Acceptance Criteria — Phase 1

| # | Check |
|---|---|
| 1 | `aperture ./examples/empty.mjs <cwd>` opens a window and holds it open until the user closes it |
| 2 | `aperture ./examples/throw.mjs <cwd>` replaces the window with a death screen; Reload relaunches |
| 3 | `aperture ./examples/log.mjs <cwd>` prints `[script:info] hi from log.mjs …` in the dev-tools console |
| 4 | A second launch against the same canonical script exits with an error; the first window focuses |
| 5 | `~/.aperture/` and subdirs exist after first launch and are not modified on second launch |
| 6 | `aperture https://example.com/foo.mjs <cwd>` exits with "deferred to Phase 6" |
| 7 | Garbage NDJSON on stdout is reported to the console without crashing the parser |
| 8 | Closing the window sends `{"type":"cancel"}` on stdin and waits ≤ 5s before SIGKILL |

## Acceptance Criteria — Phase 2

All ten criteria from `phases/phase-2-state-schema-and-reactivity.md` are
covered by the automated suite (`npm run test:shim`, plus
`cargo test --lib` for backend units):

| # | Check | Coverage |
|---|---|---|
| 1 | CLI `--targetDir ./src` lands as `params.targetDir` in `onLoad` | `e2e-bootstrap` AC #1 |
| 2 | CLI wins over URL query on collision | `e2e-bootstrap` AC #2 |
| 3 | `--filters='["*.js"]'` parses to an array | `e2e-bootstrap` AC #3 |
| 4 | `safeParse` failure routes to a structured `error` event | `e2e-bootstrap` AC #4 |
| 5 | `state.watch` fires on script + GUI writes; same-key serializes | `state-store` tests |
| 6 | GUI rapid-fire writes coalesce to ≤1 per ~16ms | frontend rAF coalescer (`state-bridge.ts`) |
| 7 | `.stream()` key chunks a 10MB value without stalling logs | `e2e-bootstrap` AC #7 |
| 8 | `persist()` + restart → persistKeys survive | `e2e-bootstrap` AC #8/9 |
| 9 | `// @aperture-version` minor bump discards snapshot | `cache_key` + `e2e-bootstrap` AC #8/9 |
| 10 | `from: 'schema'` keys readable via `runtime.state.get` | `e2e-bootstrap` AC #10 |

## Testing

```bash
# Frontend + shim
npm install
npm run test:shim         # 34 tests across 5 files
npm run build             # tsc + vite build

# Backend
cd src-tauri && cargo test --lib
```

## Design Contract Preserved for Later Phases

Scripts continue to `import { … } from 'aperture:runtime'`. The Phase 2
surface adds `state.set/get/setIn/push/watch/persist` as real behavior;
`invoke`, `invokeStream`, `on`, and `createWorker` still throw with a
clear phase reference. Phases 3–5 layer rendering, native calls, and
workers without needing to rewrite the script contract.
