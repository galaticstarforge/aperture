# Aperture

A GUI-native `.mjs` script runner. Define a script, get a GUI for free.

See [`design.md`](./design.md) for the full v2 design spec and
[`phases/`](./phases) for the phased implementation plan.

## Status — Phase 1 (Foundation & Process Model)

This branch implements the foundation from
[`phases/phase-1-foundation-and-process-model.md`](./phases/phase-1-foundation-and-process-model.md):

- Tauri 2.x + React + Vite shell (dark theme, Lucide icons)
- Binary entry point: `aperture <script-source> <working-dir>`
- Argv parsing with `--offline` and `--key value` / `--key=value` flags
- Remote URL sources rejected with a clear "deferred to Phase 6" error
- `~/.aperture/` filesystem layout (`deps/ scripts/ state/ windows/ logs/ locks/`)
- Multi-instance guard (file lock + Tauri single-instance plugin)
- Child-process script host (system Node; bundled Bun-Node arrives in Phase 6)
- NDJSON protocol on stdout; raw stderr stream; full `ScriptEvent` /
  `GUIEvent` unions defined
- Virtual `aperture:runtime` module via Node's `module.register` hooks —
  `progress` and `log` are real; everything else is a stub that throws a
  clear "not implemented until Phase N" error
- Lifecycle skeleton: install screen → running view → death screen with
  **Reload Script** (Cmd/Ctrl+R)
- `cancel` sent to the child on window close with a 5s grace window

State/zod, the element renderer, the `invoke` suite, workers, and the CLI
sub-commands (`new`/`dev`/`validate`/`run`/`docs`) land in phases 2–6.

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
│   ├── shim.mjs               # exported API stubs
│   └── bootstrap.mjs          # per-child lifecycle driver
└── examples/
    ├── empty.mjs              # AC #1 — window opens, stays alive
    ├── log.mjs                # AC #3 — log() emits NDJSON
    └── throw.mjs              # AC #2 — crash → death screen
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

## Design Contract Preserved for Later Phases

Scripts can already `import { … } from 'aperture:runtime'` and see the full
API surface — calls to stubbed members throw with a clear reference to the
phase that implements them. This means Phase 2/3/4/5 land without needing to
touch the script contract.
