# Phase 6 — CLI Tooling, Caching & Distribution

> Everything a developer (and an LLM) needs to author Aperture scripts,
> plus everything required to ship Aperture itself: dep installs via
> bun, semver-aware caching, remote URL handling, env-var approvals,
> window persistence, and single-binary packaging for all three target
> platforms.

## Goal

`aperture new|dev|validate|run|docs` all work. Remote URLs load and
cache correctly. Dependencies install reproducibly via bun into the
shared global cache. Env-var requirements prompt once per script and
persist. Window sizes persist per-script. Aperture ships as a single
binary for macOS, Windows, and Linux x86_64 with Node runtime bundled
via Bun.

## Scope (in)

From `design.md`:

- §"CLI" — every sub-command:
  - `aperture new <name>` — scaffold with commented skeleton, one state
    key, one button, one callback.
  - `aperture dev <script.mjs>` — verbose output; worker static
    analysis ON; live protocol inspector for NDJSON traffic.
  - `aperture validate <script.mjs>` — structured JSON issues always
    (`{ line, column, code, message, hint }`), tuned for LLM auto-fix.
  - `aperture run <script.mjs>` — headless; requires `export async
    function headless(params, runtime)`; exits when headless resolves.
  - `aperture docs` — LLM-optimized markdown reference;
    `--section elements | runtime | contract` filters.
- §"Binary / GUI Runtime" — remote URL handling:
  - URL vs path dispatch (locked in Phase 1; now the URL path actually
    downloads).
  - Canonical source derivation strips signing parameters (`X-Amz-*`,
    any `?signature=`, etc.) so signed URLs are stable cache keys.
- §"Startup Flow" — full install/update pipeline:
  - Peek source; parse `// @aperture-version`; compare `major.minor`
    against cache.
  - Hit → launch immediately.
  - Miss / version change → install screen with the precise copy:
    - First run: `Installing dependencies…`
    - Version change: `Updating to vX.Y.Z…`
  - Indeterminate progress bar during install.
- §"Offline Mode" — `--offline` flag skips all network/version checks;
  fails cleanly if not cached.
- §"`// @aperture-version` and Cache Invalidation" — patch bumps reuse
  cache, minor/major invalidate; unversioned scripts never cache.
- §"Dependencies" — bare names + `name@semver`; bun installs into
  `~/.aperture/deps/`.
- §"Execution Runtime Details" — Node bundled via Bun for single-binary
  distribution; bun manages deps; stderr ring-buffered to
  `~/.aperture/logs/`.
- §"Filesystem Layout" — all paths finalized, including the cache-key
  shape for `scripts/`, `state/`, `windows/`.
- §"Window Configuration" — per-script persistence at
  `~/.aperture/windows/<cache-key>.json`; overrides script defaults on
  subsequent launches.
- §"Env vars" — `export const env = ['MY_API_KEY']` whitelist; user
  approves on first run; approval persists per script in
  `~/.aperture/config.json`.
- §"LLM Authoring Support" — `aperture docs` as the canonical
  prompt-priming document.
- Live protocol inspector (dev mode) — a panel that shows every inbound
  and outbound NDJSON event with timestamps; filterable by type.
- Worker static analysis — the Phase 5 seam wired to an actual walker
  that emits `{ line, column, code, message, hint }` warnings for
  unresolved outer-scope identifiers. Validator failure policy: always
  warnings, never errors, never runtime failures.

## Scope (out)

- Accessibility (ARIA, screen readers) — deferred post-v1.
- Node inspector integration — explicitly dropped in design.
- GUI crash recovery (design open question — kill-and-restart vs
  reattach) — document a default of kill-and-restart; revisit after
  dogfooding.
- Backpressure policy for `invokeStream` (design open question) — still
  deferred; logged as a known gap from Phase 4.
- Auto-derived labels (design open question) — escalated from Phase 3;
  Phase 6 resolves it one way or the other before feature freeze. The
  default here is **do not auto-derive** so scripts read predictably.

## Work Items

### `aperture new <name>`

- Scaffold a `<name>.mjs` in the current directory with:
  - `// @aperture-version 1.0.0` header.
  - Commented sections for each export.
  - One state key (`count`), one button, one callback that increments.
  - An `onLoad` that logs "ready".
- If `<name>.mjs` exists, refuse with a clear error (no overwrite).

### `aperture dev <script.mjs>`

- Launches the binary with:
  - Verbose NDJSON tracing to stderr.
  - Worker static analysis enabled.
  - Live protocol inspector panel visible by default.
  - Death-screen stack traces include the NDJSON tail.

### `aperture validate <script.mjs>`

- Loads the script via dynamic import in a harness that does NOT launch
  the GUI.
- Checks:
  - Required exports present (`onLoad` minimum; `headless` if asked to
    lint for run-mode).
  - `schema` / `state` are zod schemas.
  - `deps` entries parse as `name` or `name@semver`.
  - `ui` is either an object with a `type` or a function.
  - Callback references in `ui` (`onClick`, `onSelect`, `onExpand`,
    `bulkActions[].onClick`, etc.) resolve to named exports.
  - `meta` keys correspond to named exports.
  - `formatters` keys don't shadow built-ins unless the user is
    explicit (warn, not error).
  - Worker functions — static analysis for unresolved outer-scope
    identifiers (warnings only).
- Emits **always** as JSON to stdout:
  ```json
  { "issues": [ { "line": 12, "column": 4, "code": "unknown-export",
                  "message": "...", "hint": "..." } ] }
  ```
- Exit code: `0` even with issues, unless the file cannot be imported
  at all (then `1` with a single `fatal` issue). The rule is: tuned
  for LLM auto-fix loops, not for CI gating.

### `aperture run <script.mjs>`

- Headless execution. No window.
- Merges CLI flags + URL query exactly like Phase 2's launch path.
- Requires `export async function headless(params, runtime)`; if
  absent, exit with a validator-style JSON error.
- `runtime.invoke` / `invokeStream` — the invoke suite's GUI-dependent
  targets (`filePicker`, `confirm`, `prompt`, `notification`) throw a
  clear `'not-available-headless'` error. `openExternal` and
  `clipboard` remain usable.
- Stdout reserved for NDJSON (or a final `result`); stderr for logs.
- Exit code = 0 on clean resolution; 1 on throw (mirroring the death
  screen's boundary).

### `aperture docs`

- Emits a single markdown document to stdout covering:
  - Element registry (every element + key props).
  - Runtime API (`state`, `invoke`, `invokeStream`, `progress`, `log`,
    `createWorker`, `params`, `signal`).
  - Script contract (all exports, schema vs state, `meta`, env, deps).
  - Canonical examples.
- `--section elements | runtime | contract` filters to one area.
- Output is static — generated from source-of-truth constants in the
  runtime (e.g. the element registry map) so it cannot drift from
  implementation.
- Designed for LLM prompt priming; no marketing prose, no anecdotes,
  just contracts and examples.

### Remote URL loader

- Any source starting with `http://` / `https://`:
  - Canonicalize: parse URL, drop signing parameters (regex:
    `^X-Amz-`, plus explicit `signature`, `x-signature`, `token`) from
    the query string, then reassemble. Preserve all other query params
    as part of the cache key.
  - Compute cache key: `sha256(canonical_url) + '-' + majorMinor`.
  - Peek: HEAD (or short ranged GET) to pull the first N bytes for the
    version comment. If the server doesn't support it, fall through to
    a full GET.
  - On cache hit with matching `major.minor`, skip download and
    launch.
  - On miss / version change, download in full to
    `~/.aperture/scripts/<cache-key>.mjs` and proceed to dep install.
- Download failures: clear error on the install screen; retry
  button; after retry failure, show the death screen.

### bun-backed dep install

- `~/.aperture/deps/` is a shared bun-managed workspace.
- For each launch with a cache miss:
  1. Resolve each `deps[]` entry to a lockfile stanza (bare → latest
     at time of install; `name@semver` → pinned).
  2. Run `bun install` in the shared workspace, pulling only the
     needed packages.
  3. Resolve `node_modules` paths relative to the workspace for the
     child process's `NODE_PATH` / import resolution.
- Installs are concurrent-safe — a file lock inside `~/.aperture/deps/`
  prevents two launches from stomping.
- Failures → death screen with install log tail.

### Cache semantics

- Cache key = `sha256(canonical_source) + '-' + majorMinor` everywhere
  (scripts, state, windows). This is the lock-down mentioned in Phase
  2's risk list.
- Scripts without `// @aperture-version` are NEVER cached — every
  launch re-downloads (if remote) and re-installs deps. Document the
  penalty.
- Patch bumps: `2.0.0 → 2.0.1` keep the same `majorMinor`, cache
  reused, deps reused.
- Minor/major bumps: new `majorMinor`, cache entry is fresh, persisted
  state from the older key is NOT migrated (script authors manage
  migrations explicitly or lose old state — called out in design).

### `--offline` flag

- Skips: version comment peek, remote download, bun install.
- If the cache key isn't present, fail with a clear "not in cache"
  error.
- If the cache key IS present but a dep subdir is missing, fail
  similarly — never fall back to an install under `--offline`.

### Env-var approval flow

- On launch, if `export const env = […]` is non-empty:
  - Look up `~/.aperture/config.json` → `envApprovals[cacheKey]`.
  - If present AND the declared set is a subset of the approved set,
    pass-through those env vars from the parent process.
  - Else, show a pre-launch approval dialog listing the requested
    names (values never shown). On approve, persist; on deny, exit.
- Env vars NOT in the declared set are always stripped from the child.

### Window persistence

- `~/.aperture/windows/<cache-key>.json` stores
  `{ width, height, x, y }`.
- On launch, read this file and override the script's `export const
  window` size (but not `title`/`resizable`/`min*` constraints).
- Write on window move/resize debounced to ~500ms.

### stderr log ring-buffer

- Write stderr per-script to
  `~/.aperture/logs/<cache-key>.log` with a rolling cap (e.g. 5 MB ×
  3 files).
- Use this for post-mortem inspection on crashes — the death screen
  gets a "Show log" link that opens the current file.

### Single-binary packaging

- Bundle Node via Bun's single-file executable (`bun build --compile`)
  for the script host.
- Bundle the Tauri binary with the React/Vite frontend embedded.
- One binary per platform:
  - `aperture-macos-x86_64`
  - `aperture-windows-x86_64.exe`
  - `aperture-linux-x86_64`
- CI (GitHub Actions matrix over the three OSes) produces all three
  from a single tag push.
- Smoke test in CI: run `aperture run` against a tiny fixture script
  and assert `result` on stdout.
- Release notes pull from a CHANGELOG; SemVer applies to the Aperture
  binary itself (independent of script `@aperture-version`).

### Multi-instance polish

- The Phase 1 lock-file guard graduates: on second launch with the
  same canonical source, focus the existing window via IPC (Tauri
  single-instance plugin) and exit 0. Only exit with an error if
  focus cannot be delivered.

## Acceptance Criteria

1. `aperture new scanner` creates `scanner.mjs` with a working
   scaffold that runs under `aperture ./scanner.mjs <cwd>` without
   edits.
2. `aperture validate ./broken.mjs` emits a JSON blob with an
   `issues[]` list including `{ line, column, code, message, hint }`
   for each defect; exit 0.
3. `aperture validate ./syntax-error.mjs` emits one `fatal` issue and
   exits 1.
4. `aperture run ./headless.mjs <cwd>` executes the headless export
   and exits 0; launching a script without a `headless` export emits
   a validator-style error and exits 1.
5. `aperture docs` prints a complete reference; `aperture docs
   --section elements` prints only the registry subsection.
6. `aperture dev ./x.mjs` opens the window with the live protocol
   inspector visible and emits worker-analysis warnings (if any)
   before launch.
7. Running `aperture https://host/x.mjs?X-Amz-Signature=abc <cwd>`
   once downloads, installs deps, caches, and launches; a second run
   with a *different* signature (same URL otherwise) hits the cache
   and launches instantly.
8. Bumping `// @aperture-version` from `1.0.0` to `1.0.1` (patch)
   reuses the cache; bumping to `1.1.0` installs fresh.
9. `--offline` launches from cache; fails cleanly when the cache is
   empty.
10. A script with `export const env = ['MY_TOKEN']` prompts on first
    run, persists approval on accept, and passes through `MY_TOKEN`
    to the child on the next launch without prompting. An unrelated
    env var from the parent process is never visible to the child.
11. Resizing the window and relaunching opens at the new size.
    Changing `export const window.width` in the script does NOT
    override a persisted size (the persisted value wins, per design).
12. Two launches of the same script focus a single window; neither
    spawns a duplicate process.
13. CI produces three platform binaries from a tag; each runs
    `aperture run ./ci-smoke.mjs` and exits 0 with a `result` line on
    stdout.

## Dependencies

- Phase 1 (FS layout, child process host, multi-instance guard lock
  file, install-screen chrome).
- Phase 2 (manifest parsing, cache-key shape unification).
- Phase 3 (window config application; log panel for stderr).
- Phase 4 (invoke suite for the pre-launch env-approval dialog, which
  reuses `invoke('confirm', …)` chrome).
- Phase 5 (worker static-analysis seam, virtualization libraries
  already in the bundle).

## Risks & Open Questions

- **Bundled Bun binary size.** `bun build --compile` produces
  ~90 MB binaries today. Combined with Tauri, expect ~120 MB per
  platform. Document target; revisit if unacceptable.
- **Remote URL peek.** HEAD + short range GET isn't universally
  supported. Worst case falls through to full GET — acceptable but
  slower on first launch. Measure in practice.
- **Cache-key cross-contamination.** If the canonicalization rule is
  wrong (e.g. a custom auth scheme uses a non-`X-Amz-` parameter),
  different users could collide on the same cache key. Ship a conservative
  default that strips only known signing params, and document the
  rule so script authors can avoid trouble.
- **Validator scope creep.** The temptation to make `validate` error
  on style issues is strong; resist — design is explicit about
  warnings-only for worker outer-scope, and LLM auto-fix favors
  "always emit JSON, zero exit code unless unimportable."
- **Design open questions still open at v1 ship.** GUI crash recovery,
  worker memory limits, `invokeStream` backpressure, auto-derived
  labels, and URL-vs-CLI conflict warning copy all remain. Phase 6
  ships with conservative defaults and a documented list of followups;
  none block release.
