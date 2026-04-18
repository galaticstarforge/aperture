// aperture validate <script.mjs> [--headless-lint]
//
// Loads the script via dynamic import in a harness that does NOT launch the GUI.
// Always emits JSON to stdout: { "issues": [ { line, column, code, message, hint } ] }
// Exit code: 0 even with issues; 1 only if the file cannot be imported at all.

import { pathToFileURL } from 'node:url'
import { readFile } from 'node:fs/promises'
import { isZodSchema } from './schema-markers.mjs'
import { install as installSchemaMarkers } from './schema-markers.mjs'

installSchemaMarkers()

const BUILT_IN_FORMATTERS = new Set([
  'fileSize', 'date', 'dateTime', 'number', 'percent', 'currency', 'duration',
  'boolean', 'json', 'truncate',
])

const UI_CALLBACK_PROPS = [
  'onClick', 'onSelect', 'onExpand', 'onCollapse', 'onChange',
]

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const headlessLint = args.includes('--headless-lint')
const scriptArg = args.find((a) => !a.startsWith('--'))

if (!scriptArg) {
  emit({ issues: [fatal('no-script', 'No script path provided', 'Pass a path: aperture validate ./script.mjs')] })
  process.exit(1)
}

// ── Attempt dynamic import ────────────────────────────────────────────────────

let userModule
try {
  const url = scriptArg.startsWith('file:')
    ? scriptArg
    : pathToFileURL(scriptArg).href
  userModule = await import(url)
} catch (err) {
  const msg = err?.message ?? String(err)
  const lineCol = extractLineCol(msg)
  emit({
    issues: [
      {
        line: lineCol.line,
        column: lineCol.column,
        code: 'import-failed',
        message: `Script cannot be imported: ${msg}`,
        hint: 'Check for syntax errors with `node --check ./script.mjs`',
        fatal: true,
      },
    ],
  })
  process.exit(1)
}

// ── Collect issues ────────────────────────────────────────────────────────────

const issues = []

function issue(code, message, hint, line = 0, column = 0) {
  issues.push({ line, column, code, message, hint })
}

function warn(code, message, hint, line = 0, column = 0) {
  issues.push({ line, column, code, message, hint, severity: 'warning' })
}

// onLoad is required.
if (typeof userModule.onLoad !== 'function') {
  issue('missing-onload', '`export async function onLoad(params, runtime)` is required', 'Add an onLoad export to your script')
}

// headless required if --headless-lint.
if (headlessLint && typeof userModule.headless !== 'function') {
  issue('missing-headless', '`export async function headless(params, runtime)` is required for headless mode', 'Add a headless export, or remove the --headless-lint flag')
}

// schema / state must be zod schemas if present.
if (userModule.schema !== undefined && !isZodSchema(userModule.schema)) {
  issue('invalid-schema', '`export const schema` must be a zod schema', 'Use z.object({...}) from the zod package')
}
if (userModule.state !== undefined && !isZodSchema(userModule.state)) {
  issue('invalid-state', '`export const state` must be a zod schema', 'Use z.object({...}) from the zod package')
}

// deps entries must be name or name@semver.
const DEPS_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(@.+)?$/i
if (Array.isArray(userModule.deps)) {
  for (const dep of userModule.deps) {
    if (typeof dep !== 'string' || !DEPS_RE.test(dep)) {
      issue('invalid-dep', `Invalid dep entry: ${JSON.stringify(dep)}`, 'Use bare name "lodash" or versioned "lodash@4.17.21"')
    }
  }
} else if (userModule.deps !== undefined) {
  issue('invalid-deps', '`export const deps` must be an array of strings', 'Change to: export const deps = ["pkg@version"]')
}

// ui must be an object with `type` or a function.
if (userModule.ui !== undefined) {
  const ui = userModule.ui
  if (typeof ui !== 'function' && !(typeof ui === 'object' && ui !== null && typeof ui.type === 'string')) {
    issue('invalid-ui', '`export const ui` must be an object with a `type` property or a function `(state, params) => tree`', 'Add a `type` key to your ui object, or export a function')
  }
}

// Collect all named callback exports (non-reserved function exports).
const RESERVED = new Set([
  'onLoad', 'onExit', 'headless', 'deps', 'env', 'window',
  'schema', 'state', 'ui', 'formatters', 'meta', 'timeoutMs', 'default',
])
const namedExports = new Set(
  Object.entries(userModule)
    .filter(([k, v]) => typeof v === 'function' && !RESERVED.has(k))
    .map(([k]) => k)
)

// Validate callback references in ui tree.
if (userModule.ui) {
  const uiTree = typeof userModule.ui === 'function' ? null : userModule.ui
  if (uiTree) {
    checkCallbacksInTree(uiTree, namedExports, issues)
  }
}

// meta keys must correspond to named exports.
if (userModule.meta && typeof userModule.meta === 'object') {
  for (const [k] of Object.entries(userModule.meta)) {
    if (!namedExports.has(k) && typeof userModule[k] !== 'function') {
      issue('unknown-meta-key', `meta.${k} references an export that doesn't exist`, `Add: export async function ${k}(args, runtime) {}`)
    }
  }
}

// formatters should not shadow built-ins (warn, not error).
if (userModule.formatters && typeof userModule.formatters === 'object') {
  for (const [k] of Object.entries(userModule.formatters)) {
    if (BUILT_IN_FORMATTERS.has(k)) {
      warn('formatter-shadows-builtin', `Formatter "${k}" shadows a built-in formatter`, 'Use a unique name, or remove the built-in override intentionally')
    }
  }
}

// Worker static analysis (warnings only).
await analyzeWorkers(userModule, issues)

emit({ issues })
process.exit(0)

// ── Helpers ───────────────────────────────────────────────────────────────────

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

function fatal(code, message, hint) {
  return { line: 0, column: 0, code, message, hint, fatal: true }
}

function extractLineCol(msg) {
  // Node.js syntax errors include :line:col in the message.
  const m = msg.match(/:(\d+)(?::(\d+))?/)
  if (m) return { line: parseInt(m[1], 10), column: m[2] ? parseInt(m[2], 10) : 0 }
  return { line: 0, column: 0 }
}

function checkCallbacksInTree(node, namedExports, issues) {
  if (!node || typeof node !== 'object') return
  for (const prop of UI_CALLBACK_PROPS) {
    if (typeof node[prop] === 'string' && !namedExports.has(node[prop])) {
      issues.push({
        line: 0,
        column: 0,
        code: 'unknown-callback',
        message: `UI ${prop}="${node[prop]}" references an export that doesn't exist`,
        hint: `Add: export async function ${node[prop]}(args, runtime) {}`,
      })
    }
  }
  // bulkActions
  if (Array.isArray(node.bulkActions)) {
    for (const action of node.bulkActions) {
      if (action?.onClick && typeof action.onClick === 'string' && !namedExports.has(action.onClick)) {
        issues.push({
          line: 0,
          column: 0,
          code: 'unknown-callback',
          message: `bulkActions[].onClick="${action.onClick}" references an export that doesn't exist`,
          hint: `Add: export async function ${action.onClick}(args, runtime) {}`,
        })
      }
    }
  }
  for (const key of ['children', 'footer', 'items']) {
    if (Array.isArray(node[key])) {
      for (const child of node[key]) checkCallbacksInTree(child, namedExports, issues)
    }
  }
  if (Array.isArray(node.items)) {
    for (const tab of node.items) {
      if (Array.isArray(tab.children)) {
        for (const child of tab.children) checkCallbacksInTree(child, namedExports, issues)
      }
    }
  }
}

async function analyzeWorkers(userModule, issues) {
  // Static analysis of worker function bodies for unresolved outer-scope identifiers.
  // This is warnings-only — never errors.
  for (const [name, fn] of Object.entries(userModule)) {
    if (typeof fn !== 'function' || RESERVED.has(name)) continue
    // Heuristic: look for common runtime references that aren't available inside workers.
    const src = fn.toString()
    if (src.includes('createWorker')) {
      // Scan the worker function body for identifiers that look like outer-scope references.
      const workerFnMatch = src.match(/createWorker\s*\(\s*(async\s+)?(function[^(]*\(|[^=>]+=>|\([^)]*\)\s*=>)/)
      if (workerFnMatch) {
        // Simple heuristic: warn about `runtime.` usage inside worker bodies
        // (runtime is not available in workers — they get { emit, get } instead).
        const bodyStart = src.indexOf(workerFnMatch[0])
        const body = src.slice(bodyStart)
        if (body.includes('runtime.')) {
          issues.push({
            line: 0,
            column: 0,
            code: 'worker-runtime-ref',
            message: `Worker in "${name}" references "runtime" — use the worker's own { emit, get } API instead`,
            hint: 'Workers receive { emit, get } as the second argument, not the full runtime object',
            severity: 'warning',
          })
        }
      }
    }
  }
}
