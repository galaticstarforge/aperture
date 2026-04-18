# Phase 3 — UI Rendering: Inputs, Layout, Display

> Turn the declarative `ui` export into a real rendered interface. All
> non-data elements (20 of the 28) land here along with the renderer core
> that Phase 5 extends.

## Goal

A script's `ui` export — either a static object tree or a function of
`(state, params)` — renders to a polished, dark-themed, live-binding
interface built from inputs, layout, and display elements. Visibility
predicates, keyboard shortcuts, and the color system all work.

## Scope (in)

From `design.md`:

- §"GUI Framework" — React + Vite inside Tauri, dark-theme only, React Bits
  primitives, Lucide icons referenced by string name.
- §"UI Definition" — both forms:
  1. Object-literal tree.
  2. Function `(state, params) => tree` re-called on state changes,
     required to return a structurally stable shape (same root element
     type).
- §"UI Definition" — callback refs are string names resolved at dispatch.
- §"`visibleWhen` / `disabledWhen`" — three predicate forms on every
  element: boolean key, `{ bind, value }` equality, or
  `{ bind, gt|lt|gte|lte|not }`.
- §"Element Registry" — everything except the "Data" subsection:
  - **Inputs:** `input`, `number`, `textarea`, `select` (array or
    string-state-key options), `checkbox`, `slider`, `button` (primary /
    secondary / danger), `file` (mode, filter, store ∈ path/meta/contents).
  - **Display:** `label`, `badge`, `progress`, `code`, `output` (JSON
    tree, collapsible), `stat` (delta animated on change), `alert`,
    `image` (srcType auto/path/url/base64 with deterministic rules).
  - **Layout:** `row`, `column`, `card` (title, padding, collapsible,
    footer, actions, variant), `tabs` (items with visibleWhen + keepAlive),
    `divider`, `scroll`.
- §"Tabs" — default behavior hides strip entry AND unmounts children when
  `visibleWhen` is false; `keepAlive: true` opts out of unmount.
- §"Keyboard Shortcuts" — built-in defaults (`Enter`, `Esc`, `Cmd/Ctrl+R`)
  plus per-element `shortcut` overrides.
- §"Window Configuration" — read `export const window` and apply width,
  height, resizable, minWidth, minHeight, title (default: script filename)
  on launch. Persistence to `~/.aperture/windows/...` is Phase 6.
- Color system — accept any hex string or semantic token
  (`success | danger | warning | info | neutral`) anywhere a color is
  expected.
- A minimal log panel wired to stderr + `log` events from the shim so Phase
  2's reactive state and Phase 1's IPC are finally user-visible.

## Scope (out)

- Data elements `table`, `tree`, `chart`, `timeline` (Phase 5).
- Custom formatters — Phase 3 ships the built-in formatter set
  (`bytes`, `ms`, `date`, `number`, `percent`, `relative`) and wires the
  `format` prop, but the `formatters` custom-export hookup (incl. async
  + memoization + rich `{ text, color }` output) is Phase 4.
- `invoke` suite (`filePicker`, `confirm`, `prompt`, etc.) — Phase 4. This
  means the `file` element in Phase 3 uses a plain native-ish file input;
  rich picker integration is layered on in Phase 4.
- `meta.returnsInto` auto-writes (Phase 4).
- Async formatter shimmer and memoization (Phase 4).

## Work Items

### Renderer core

- A single React component `<Element node={...} />` dispatches on
  `node.type` into a registry map `{ [type]: Component }`.
- The root subscribes to `runtime.state` (via the Phase 2 store, exposed
  to the frontend through IPC) and re-renders on any write. When `ui` is a
  function, call it with `(state, params)` on each change; React diffing
  covers the fine-grained updates.
- Prop resolution helper: for every element, resolve `bind` → live state
  value, `disabledWhen` / `visibleWhen` → boolean, `format` → string
  transformer. Predicates share a single evaluator covering all three
  forms.
- Cell-context variant of the resolver (resolves `bind` against a row
  object) is stubbed here but only exercised in Phase 5.

### Element implementations

Each element reads from state via `bind` and writes through Phase 2's
`state.set` on user input. Two-way binding is the default for inputs.

- `input` — text / email / password; label; placeholder; shortcut. Wires
  GUI→script writes through the `state:changed` coalesced path.
- `number` — min/max/step; parses NaN-safe before writing.
- `textarea` — rows; resizable.
- `select` — options either an inline array (`[{ value, label }]` or bare
  strings) OR a string state key (e.g. `'regions'`) that resolves to an
  array at render.
- `checkbox` — boolean, label left or right per style guide.
- `slider` — min/max/step; number bind.
- `button` — `onClick: 'callbackName'` dispatches a `call` GUIEvent; variant
  controls color; `disabledWhen` respected; `shortcut` registers a
  keybinding that triggers the same callback.
- `file` — Phase 3 version uses the OS-native file chooser via Tauri's
  dialog plugin; the `store` prop controls what lands in state:
  - `'path'` (default) — absolute string.
  - `'meta'` — `{ path, name, size, type }` (stat'd when the user selects).
  - `'contents'` — UTF-8 string or base64 heuristic by extension.
- `label` — `bind` or `text`; `format` applies a built-in formatter.
- `badge` — `variants` map: value → color (semantic OR hex).
- `progress` — 0..1, `indeterminate` shimmer.
- `code` — read-only syntax-highlighted block (prism-style highlighter;
  language prop).
- `output` — JSON tree renderer with collapsible nodes.
- `stat` — value with optional `delta` (state key) animated on change
  (count-up / flash).
- `alert` — level-colored banner, `bind` or static `message`.
- `image` — `srcType: 'auto'` rules:
  - starts with `data:` → base64
  - starts with `http://` or `https://` → url
  - otherwise → path; if not absolute, resolve against `cwd` passed from
    Phase 1.
- `row`, `column` — flex primitives; `gap`, `align`, `justify`.
- `card` — title, padding, collapsible (client-state only), footer,
  actions strip, variant (`default | info | danger`).
- `tabs` — strip + panels; `visibleWhen` per item hides + unmounts;
  `keepAlive: true` keeps children mounted while strip entry hidden.
- `divider` — optional `label`.
- `scroll` — `maxHeight` clamp; children overflow scrolls inside.

### Predicate evaluator

Single `evaluatePredicate(pred, ctx)` helper:

- `string`  → truthy check against `ctx.state[pred]`.
- `{ bind, value }` → `ctx.state[bind] === value`.
- `{ bind, gt|lt|gte|lte|not }` → numeric comparison or inequality.

`ctx` defaults to global state but can be a row/node object in cell
contexts (Phase 5 uses this).

### Color system

- Token → CSS var (`--aperture-success`, etc.), defined once in the app
  theme.
- Any hex string passes through verbatim.
- Single helper `resolveColor(input)` used by every element that accepts a
  color.

### Keyboard shortcuts

- Central registry component at the app root registers:
  - `Enter` → primary button of the active form/card scope.
  - `Esc` → cancel button if present in scope, else closes the active modal.
  - `Cmd/Ctrl+R` → Reload Script (shared with the Phase 1 death-screen
    button; routes through the same relaunch codepath).
- Per-element `shortcut` overrides register through a shared hook; last
  registration wins, unregistered cleanly on unmount. Case-insensitive
  parser for common forms (`cmd+s`, `ctrl+enter`, `/`).

### Window configuration

- Read `export const window` from Phase 2's manifest on launch.
- Apply width/height/minWidth/minHeight/resizable/title to the Tauri
  window before the renderer mounts.
- Default title is the script's filename when `window.title` is absent.

### Log panel

- Persistent bottom-docked collapsible panel showing:
  - stderr lines (raw) from the child process.
  - `log` events from the runtime shim (level-colored).
- Design-doc §"Debugging Model" satisfied for non-timeline logging.
  Timeline-element integration comes with Phase 5.

## Acceptance Criteria

1. A script whose `ui` is a static `column` of `input`, `slider`,
   `checkbox`, `button` renders all four elements, all bound.
2. Typing into an `input` bound to `state.x` updates the in-child value
   observable via a `watch('x', …)` registered in `onLoad`.
3. A function-form `ui` that maps `state.files` to a column of `label`s
   updates its row count when the bound array grows (writes from a
   callback trigger a re-render).
4. `visibleWhen: 'isAdvanced'` hides its subtree when `state.isAdvanced`
   is false; `visibleWhen: { bind: 'count', gt: 0 }` shows when count > 0.
5. `tabs` with a `keepAlive: true` panel preserves its scroll position
   when its strip entry becomes hidden via `visibleWhen`; a non-keepAlive
   panel unmounts and resets state.
6. Button `shortcut: 'cmd+s'` fires the bound callback on that keystroke;
   global `Cmd+R` reloads the script from anywhere in the app.
7. `badge` with `variants: { ok: 'success', fail: '#ff0000' }` renders
   both a token color and a literal hex correctly.
8. `image` with `srcType: 'auto'` routes a relative path through
   `cwd`-relative resolution, an `https://…` URL through the URL loader,
   and `data:image/png;base64,…` through the base64 loader.
9. Window dimensions and title from `export const window` apply on
   launch; absence of `window.title` defaults to the script filename.
10. stderr from the child and `runtime.log(...)` calls both appear in the
    log panel, color-coded by level.

## Dependencies

- Phase 1 (shell, IPC) and Phase 2 (state, schema, manifest extraction).

## Risks & Open Questions

- **Function-form ui stability.** Re-calling `ui(state, params)` on every
  state change can be expensive; rely on React memoization and consider a
  per-frame throttle if profiling shows >16ms render.
- **Shortcut conflicts.** Per-element `shortcut` overriding a built-in
  (e.g. a `button` with `shortcut: 'esc'`) is allowed; document that this
  shadows the built-in Esc-to-cancel behavior for that scope.
- **File element vs invoke('filePicker').** Phase 3's native file element
  uses Tauri's dialog plugin directly; Phase 4 exposes the same plugin
  through `invoke('filePicker', …)`. Share one implementation module so
  behavior stays aligned.
- **Design open question — auto-derived labels** (`targetDir` → "Target
  Dir") — **NOT** implemented in Phase 3. Escalate as a follow-up decision
  before Phase 6 feature freeze.
