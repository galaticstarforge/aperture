//! Non-GUI CLI subcommand handlers.
//!
//! `new`      — scaffold a template script
//! `validate` — run the JS validation harness and print JSON issues
//! `docs`     — emit the LLM-optimized markdown reference to stdout
//! `run`      — headless script execution (spawns Node, reads NDJSON)

use std::path::{Path, PathBuf};
use std::process::Stdio;

use crate::cli::{DocSection, ParsedArgs};

// ─────────────────────────────── aperture new ─────────────────────────────────

pub fn cmd_new(name: String) -> anyhow::Result<()> {
    let filename = if name.ends_with(".mjs") {
        name.clone()
    } else {
        format!("{}.mjs", name)
    };
    let dest = std::env::current_dir()?.join(&filename);
    if dest.exists() {
        anyhow::bail!(
            "aperture new: `{}` already exists — refusing to overwrite",
            dest.display()
        );
    }
    let template = build_template(&name);
    std::fs::write(&dest, template)?;
    eprintln!("aperture: created {}", dest.display());
    Ok(())
}

fn build_template(name: &str) -> String {
    let title = name.trim_end_matches(".mjs");
    format!(
        r#"// @aperture-version 1.0.0
// Aperture script — {title}
// Run with: aperture ./{title}.mjs <cwd>

import {{ z }} from 'zod'

// ── State schema ──────────────────────────────────────────────────────────────
// Declare reactive state keys with types and defaults.
export const state = z.object({{
  count: z.number().default(0),
}})

// ── Window configuration (optional) ──────────────────────────────────────────
// export const window = {{ title: '{title}', width: 800, height: 600 }}

// ── Dependencies (optional) ───────────────────────────────────────────────────
// export const deps = ['lodash', 'axios@1.6.0']

// ── Env vars required from parent process (optional) ─────────────────────────
// export const env = ['MY_API_KEY']

// ── UI definition ─────────────────────────────────────────────────────────────
// Return a UI tree describing the interface. Receives live state + params.
export const ui = (s) => ({{
  type: 'column',
  children: [
    {{ type: 'stat', label: 'Count', value: s.count }},
    {{ type: 'button', label: 'Increment', onClick: 'increment' }},
  ],
}})

// ── Script lifecycle ──────────────────────────────────────────────────────────
export async function onLoad(_params, runtime) {{
  runtime.log('ready')
}}

// ── Callbacks ─────────────────────────────────────────────────────────────────
export async function increment(_args, runtime) {{
  const current = runtime.state.get('count') ?? 0
  runtime.state.set('count', current + 1)
}}

// ── Headless entry point (for `aperture run`) ─────────────────────────────────
// export async function headless(params, runtime) {{
//   runtime.log('running headless')
//   return {{ done: true }}
// }}
"#,
        title = title
    )
}

// ─────────────────────────────── aperture validate ────────────────────────────

pub fn cmd_validate(script: PathBuf, headless_lint: bool, bundled: &BundledPaths) -> anyhow::Result<()> {
    let node_bin = resolve_node().map_err(|e| {
        anyhow::anyhow!("Could not find Node.js: {e}")
    })?;

    let harness = bundled.validate_harness.clone();
    if !harness.is_file() {
        anyhow::bail!("validate harness not found at {}", harness.display());
    }

    let mut cmd = std::process::Command::new(&node_bin);
    cmd.arg("--import")
        .arg(path_to_file_url(&bundled.loader_module))
        .arg(&harness)
        .arg(&script);
    if headless_lint {
        cmd.arg("--headless-lint");
    }
    for np in &bundled.node_paths {
        let existing = std::env::var("NODE_PATH").unwrap_or_default();
        let sep = if cfg!(windows) { ";" } else { ":" };
        let new_np = if existing.is_empty() {
            np.to_string_lossy().into_owned()
        } else {
            format!("{}{}{}", existing, sep, np.display())
        };
        cmd.env("NODE_PATH", new_np);
    }

    let status = cmd.status()?;
    std::process::exit(status.code().unwrap_or(1));
}

// ─────────────────────────────── aperture docs ────────────────────────────────

pub fn cmd_docs(section: Option<DocSection>) -> anyhow::Result<()> {
    let full = build_docs();
    match section {
        None => print!("{}", full),
        Some(DocSection::Elements) => print!("{}", extract_section(&full, "## Elements")),
        Some(DocSection::Runtime) => print!("{}", extract_section(&full, "## Runtime API")),
        Some(DocSection::Contract) => print!("{}", extract_section(&full, "## Script Contract")),
    }
    Ok(())
}

fn extract_section<'a>(full: &'a str, heading: &str) -> &'a str {
    let start = match full.find(heading) {
        Some(i) => i,
        None => return full,
    };
    // Find next `## ` heading after start, or end of string.
    let rest = &full[start + heading.len()..];
    let end_offset = rest.find("\n## ").map(|i| i + 1).unwrap_or(rest.len());
    let end = start + heading.len() + end_offset;
    full[start..end].trim_end()
}

fn build_docs() -> String {
    r#"# Aperture Script Reference

> This document is the canonical LLM-priming reference for Aperture v1.
> Run `aperture docs --section elements|runtime|contract` for a subsection.

---

## Elements

Every element is an object `{ type, ...props }`. The `ui` export may be a
static tree or a function `(state, params) => tree` for reactive layouts.

### Layout

| type | key props |
|------|-----------|
| `column` | `children[]`, `gap?`, `padding?` |
| `row` | `children[]`, `gap?`, `align?` |
| `card` | `children[]`, `title?` |
| `tabs` | `items[{ label, children[] }]`, `defaultTab?` |
| `scroll` | `children[]`, `height?` |
| `divider` | _(no extra props)_ |

### Display

| type | key props |
|------|-----------|
| `label` | `value` |
| `badge` | `value`, `color?` |
| `stat` | `label`, `value`, `delta?` |
| `progress` | `value` (0–1), `label?` |
| `code` | `value`, `language?` |
| `output` | `value` (string), `wrap?` |
| `alert` | `message`, `level?` (info\|warn\|error) |
| `image` | `src`, `alt?`, `width?`, `height?` |

### Inputs

| type | key props |
|------|-----------|
| `input` | `from`, `label?`, `placeholder?` |
| `number` | `from`, `label?`, `min?`, `max?`, `step?` |
| `textarea` | `from`, `label?`, `rows?` |
| `select` | `from`, `options[]` (string or `{ label, value }`), `label?` |
| `checkbox` | `from`, `label?` |
| `slider` | `from`, `min?`, `max?`, `step?`, `label?` |
| `button` | `label`, `onClick` (callback name), `disabled?` |
| `file` | `from`, `label?`, `accept?` |

All inputs support `visibleWhen` and `disabledWhen` predicates:
```js
{ type: 'button', label: 'Submit', onClick: 'submit',
  disabledWhen: { key: 'loading', eq: true } }
```

### Data (virtualized)

| type | key props |
|------|-----------|
| `table` | `from` (state key), `columns[]`, `sortable?`, `filterable?`, `bulkActions[]` |
| `tree` | `from` (state key), `labelKey?`, `childrenKey?`, `onExpand?` |
| `chart` | `from` (state key), `chartType` (line\|area\|bar\|pie\|scatter), `xKey`, `yKey` or `dataKey` |
| `timeline` | `logTarget` (state key), `levels?` (filter array) |

#### table columns
```js
columns: [
  { key: 'name', label: 'Name', sortable: true },
  { key: 'size', label: 'Size', format: 'fileSize' },
]
```

#### bulkActions
```js
bulkActions: [{ label: 'Delete', onClick: 'deleteSelected' }]
```
Callback receives `{ selected: string[] }` (the row keys).

---

## Runtime API

Imported automatically as `aperture:runtime` — never import it manually.

### `state`

```js
runtime.state.set(key, value)         // write a state key
runtime.state.get(key)                // read a state key synchronously
runtime.state.setIn([key, ...path], v) // deep set
runtime.state.push(key, item)         // append to array state key
runtime.state.watch(key, fn)          // subscribe to changes
runtime.state.persist()               // mark current state for disk persistence
```

### `params`

```js
runtime.params   // frozen object — CLI flags + URL query merged at launch
```

### `log`

```js
runtime.log(message, level?, data?)
// level: 'info' | 'warn' | 'error' | 'debug'  (default 'info')
```

### `progress`

```js
runtime.progress(value, label?)   // value 0–1
```

### `signal`

```js
runtime.signal   // AbortSignal — aborted when window closes or cancel fires
```

### `invoke`

```js
const result = await runtime.invoke(fn, args)
```

Built-in targets:

| fn | args | result |
|----|------|--------|
| `filePicker` | `{ mode?: 'file'\|'directory'\|'multiple', filter? }` | `{ paths: string[], cancelled: bool }` |
| `confirm` | `{ message: string }` | `{ confirmed: bool }` |
| `prompt` | `{ message: string }` | `{ confirmed: bool, value?: string }` |
| `notification` | `{ title, body?, level? }` | `{ sent: bool }` |
| `openExternal` | `{ url: string }` | `{ opened: bool }` |
| `clipboard` | `{ op: 'read'\|'write', text? }` | string (read) or `{ written: bool }` |

GUI-dependent targets (`filePicker`, `confirm`, `prompt`, `notification`)
throw `'not-available-headless'` in headless (`aperture run`) mode.

### `invokeStream`

```js
for await (const chunk of runtime.invokeStream(fn, args)) { ... }
```

### `createWorker`

```js
const worker = runtime.createWorker(async (data, { emit, get }) => {
  const val = await get('myKey')   // read state from parent
  emit('progress', { value: 0.5 })
  return { done: true }
}, { name: 'my-worker' })

worker.on('progress', ({ value }) => runtime.progress(value))
const result = await worker.run(inputData)
```

### `on`

```js
runtime.on(event, handler)   // subscribe to runtime events
```

---

## Script Contract

### Exports

| export | type | required | description |
|--------|------|----------|-------------|
| `onLoad` | `async (params, runtime) => any` | yes | called once on launch |
| `onExit` | `async (runtime) => void` | no | called on close/cancel |
| `headless` | `async (params, runtime) => any` | for `run` | headless entry point |
| `state` | zod schema | no | reactive state shape + defaults |
| `schema` | zod schema | no | launch-time params schema |
| `ui` | object or `(state, params) => tree` | no | GUI layout tree |
| `deps` | `string[]` | no | npm packages (bare or `name@semver`) |
| `env` | `string[]` | no | env var names required from parent |
| `window` | `{ title?, width?, height?, resizable?, minWidth?, minHeight? }` | no | window config |
| `formatters` | `{ [name]: (value, context) => string \| Promise<string> }` | no | custom cell formatters |
| `meta` | `{ [cbName]: { returnsInto?: string } }` | no | callback metadata |
| `timeoutMs` | `number` | no | hard timeout before onExit fires |

### State vs Schema

- `schema` validates **launch-time params** (CLI flags + URL query). Zod `.parse()` is called before `onLoad`.
- `state` defines **runtime reactive state**. Keys with `.default()` are pre-populated. Both are optional.

### `meta.returnsInto`

If a callback's `meta` entry has `returnsInto`, its return value is
automatically written to that state key:

```js
export const meta = { fetchData: { returnsInto: 'rows' } }
export async function fetchData(_args, runtime) {
  return await fetch('/api/data').then(r => r.json())
}
```

### `deps` format

```js
export const deps = ['lodash', 'axios@1.6.0', 'zod@^3.0.0']
```

Bare names resolve to latest at install time. Semver ranges are pinned.
Bun installs into `~/.aperture/deps/` shared workspace.

### `env` approval

```js
export const env = ['MY_API_KEY', 'DATABASE_URL']
```

On first launch, Aperture shows a dialog listing the requested variable names
(never values). On approval, persists to `~/.aperture/config.json`. Env vars
not in this list are **always stripped** from the child process.

### Cache invalidation

Scripts include `// @aperture-version X.Y.Z` as the first comment.
- **Patch** bumps (`1.0.0 → 1.0.1`): cache reused, deps reused.
- **Minor/major** bumps: fresh cache entry, persisted state discarded.
- **No version comment**: never cached — every launch re-downloads (if remote).

### Headless mode (`aperture run`)

```js
export async function headless(params, runtime) {
  // runtime.invoke for GUI targets throws 'not-available-headless'
  // openExternal and clipboard still work
  const result = await doWork(params)
  return result   // printed as { "type": "result", "data": ... } on stdout
}
```

Exit code: `0` on clean resolution, `1` on throw.

---

## Examples

### Minimal counter

```js
// @aperture-version 1.0.0
import { z } from 'zod'
export const state = z.object({ count: z.number().default(0) })
export const ui = (s) => ({
  type: 'column',
  children: [
    { type: 'stat', label: 'Count', value: s.count },
    { type: 'button', label: '+1', onClick: 'inc' },
  ],
})
export async function onLoad(_p, rt) { rt.log('ready') }
export async function inc(_a, rt) {
  rt.state.set('count', (rt.state.get('count') ?? 0) + 1)
}
```

### File processor with progress

```js
// @aperture-version 1.0.0
import { z } from 'zod'
export const state = z.object({ log: z.array(z.any()).default([]) })
export const ui = (s) => ({
  type: 'column',
  children: [
    { type: 'button', label: 'Pick files', onClick: 'pick' },
    { type: 'timeline', logTarget: 'log' },
  ],
})
export async function onLoad(_p, rt) { rt.log('ready') }
export async function pick(_a, rt) {
  const { paths } = await rt.invoke('filePicker', { mode: 'multiple' })
  for (let i = 0; i < paths.length; i++) {
    rt.progress(i / paths.length, paths[i])
    rt.log(`processing: ${paths[i]}`)
  }
  rt.progress(1, 'done')
}
```
"#.to_string()
}

// ─────────────────────────────── aperture run (headless) ──────────────────────

pub fn cmd_run(args: ParsedArgs, bundled: &BundledPaths) -> anyhow::Result<()> {
    let node_bin = resolve_node().map_err(|e| anyhow::anyhow!("Could not find Node.js: {e}"))?;

    let script_path = match args.source.local_path() {
        Some(p) => p.to_path_buf(),
        None => {
            anyhow::bail!(
                "aperture run: remote URLs require caching — use GUI launch for remote scripts"
            );
        }
    };

    let cli_flags_json = serde_json::to_string(&args.raw_flags).unwrap_or_else(|_| "{}".to_string());
    let cache_key = crate::cache_key::derive(&script_path)
        .ok()
        .flatten()
        .unwrap_or_default();
    let layout = crate::fs_layout::Layout::resolve()?;
    layout.ensure()?;

    let mut child = std::process::Command::new(&node_bin);
    child
        .arg("--import")
        .arg(path_to_file_url(&bundled.loader_module))
        .arg(&bundled.bootstrap_module)
        .arg(&script_path)
        .env("APERTURE_SCRIPT", &script_path)
        .env("APERTURE_SOURCE", args.source.as_display())
        .env("APERTURE_CLI_FLAGS", &cli_flags_json)
        .env("APERTURE_CACHE_KEY", &cache_key)
        .env("APERTURE_STATE_DIR", &layout.state)
        .env("APERTURE_HEADLESS", "1")
        .current_dir(&args.cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());

    for np in &bundled.node_paths {
        let existing = std::env::var("NODE_PATH").unwrap_or_default();
        let sep = if cfg!(windows) { ";" } else { ":" };
        let val = if existing.is_empty() {
            np.to_string_lossy().into_owned()
        } else {
            format!("{}{}{}", existing, sep, np.display())
        };
        child.env("NODE_PATH", val);
    }

    let mut proc = child.spawn()?;
    let stdout = proc.stdout.take().expect("stdout piped");

    use std::io::{BufRead, BufReader};
    let reader = BufReader::new(stdout);
    let mut exit_code = 0i32;
    let mut result_printed = false;

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let v: serde_json::Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let ty = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        match ty {
            "result" => {
                // Print result JSON to stdout for callers.
                println!("{}", serde_json::to_string(&v).unwrap_or_default());
                result_printed = true;
            }
            "error" => {
                let msg = v.get("message").and_then(|m| m.as_str()).unwrap_or("unknown error");
                let stack = v.get("stack").and_then(|s| s.as_str()).unwrap_or("");
                eprintln!("aperture run: error: {}", msg);
                if !stack.is_empty() {
                    eprintln!("{}", stack);
                }
                exit_code = 1;
            }
            "log" => {
                let msg = v.get("message").and_then(|m| m.as_str()).unwrap_or("");
                let level = v.get("level").and_then(|l| l.as_str()).unwrap_or("info");
                eprintln!("[{}] {}", level, msg);
            }
            _ => {}
        }
    }

    let status = proc.wait()?;
    if !status.success() && exit_code == 0 {
        exit_code = status.code().unwrap_or(1);
    }
    if exit_code == 0 && !result_printed {
        // Script exited cleanly without emitting a result (no headless export)
        exit_code = 1;
        eprintln!("aperture run: script has no `headless` export — use `export async function headless(params, runtime){{}}` ");
    }
    std::process::exit(exit_code);
}

// ─────────────────────────────── shared helpers ───────────────────────────────

/// Paths to bundled Node.js assets (mirrors BundledAssets in lib.rs but usable
/// without the full Tauri context).
#[derive(Clone)]
pub struct BundledPaths {
    pub loader_module: PathBuf,
    pub bootstrap_module: PathBuf,
    pub validate_harness: PathBuf,
    pub docs_gen: PathBuf,
    pub node_paths: Vec<PathBuf>,
}

impl BundledPaths {
    pub fn resolve() -> std::io::Result<Self> {
        let here = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|x| x.to_path_buf()));
        let candidates: Vec<PathBuf> = [
            here.as_ref().map(|p| p.join("runtime-shim")),
            Some(PathBuf::from("../runtime-shim")),
            Some(PathBuf::from("runtime-shim")),
            Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../runtime-shim")),
        ]
        .into_iter()
        .flatten()
        .collect();

        for c in &candidates {
            let loader = c.join("loader.mjs");
            let bootstrap = c.join("bootstrap.mjs");
            if loader.is_file() && bootstrap.is_file() {
                let loader = std::fs::canonicalize(&loader).unwrap_or(loader);
                let bootstrap = std::fs::canonicalize(&bootstrap).unwrap_or(bootstrap);
                let validate_harness = std::fs::canonicalize(c.join("validate-harness.mjs"))
                    .unwrap_or_else(|_| c.join("validate-harness.mjs"));
                let docs_gen = std::fs::canonicalize(c.join("docs-gen.mjs"))
                    .unwrap_or_else(|_| c.join("docs-gen.mjs"));
                let mut node_paths = Vec::new();
                if let Some(parent) = bootstrap.parent().and_then(|p| p.parent()) {
                    let nm = parent.join("node_modules");
                    if nm.is_dir() {
                        node_paths.push(nm);
                    }
                }
                let manifest_nm = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../node_modules");
                if manifest_nm.is_dir() {
                    if let Ok(canon) = std::fs::canonicalize(&manifest_nm) {
                        if !node_paths.iter().any(|p| p == &canon) {
                            node_paths.push(canon);
                        }
                    }
                }
                return Ok(Self { loader_module: loader, bootstrap_module: bootstrap, validate_harness, docs_gen, node_paths });
            }
        }
        Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "runtime-shim/loader.mjs not found",
        ))
    }
}

pub fn resolve_node() -> std::io::Result<PathBuf> {
    if let Ok(p) = std::env::var("APERTURE_NODE") {
        return Ok(PathBuf::from(p));
    }
    let exe = if cfg!(windows) { "node.exe" } else { "node" };
    let path = std::env::var_os("PATH").ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::NotFound, "PATH not set")
    })?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(exe);
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err(std::io::Error::new(std::io::ErrorKind::NotFound, "`node` not found on PATH"))
}

fn path_to_file_url(p: &Path) -> String {
    url::Url::from_file_path(p)
        .map(|u| u.to_string())
        .unwrap_or_else(|_| format!("file://{}", p.display()))
}
