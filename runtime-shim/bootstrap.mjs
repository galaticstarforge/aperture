// Phase 2 child-process bootstrap.
//
// Responsibilities layered on top of Phase 1:
//   - Extract the full ScriptManifest (schema, state, ui, meta, …) up front
//   - Build the launch-time `params`: merge URL query + CLI flags, coerce
//     complex values, run `schema.safeParse`
//   - Initialize the reactive StateStore from `state.parse({})` + the
//     persisted snapshot on disk + schema-backed overlays
//   - Wire GUI → script state writes (`state:set` / `state:changed` on
//     stdin) into the same store, so watchers fire symmetrically
//   - Emit structured errors on schema/params validation failure so the
//     death screen can render them
//
// Invocation shape (from the Tauri backend):
//
//   node --import file:///.../runtime-shim/loader.mjs \
//        /.../runtime-shim/bootstrap.mjs \
//        /absolute/path/to/user/script.mjs
//
// Env:
//   APERTURE_SCRIPT     — absolute script path
//   APERTURE_SOURCE     — original source (URL or path) for query extraction
//   APERTURE_CLI_FLAGS  — JSON object of CLI --flag value pairs (raw strings)
//   APERTURE_CACHE_KEY  — string; empty when the script has no @aperture-version
//   APERTURE_STATE_DIR  — absolute path to `~/.aperture/state/`

import { pathToFileURL } from 'node:url'
import { createInterface } from 'node:readline'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as runtime from 'aperture:runtime'
import { extractManifest, buildInitialState, ManifestError } from './manifest.mjs'
import { mergeRawParams, validateParams, queryFromSource } from './params.mjs'
import { StateStore } from './state-store.mjs'

const scriptArg = process.argv[2] ?? process.env.APERTURE_SCRIPT
if (!scriptArg) {
  emitError('bootstrap: APERTURE_SCRIPT not set')
  process.exit(1)
}

const rawCliFlags = safeJson(process.env.APERTURE_CLI_FLAGS) ?? {}
const rawSource = process.env.APERTURE_SOURCE ?? scriptArg
const cacheKey = (process.env.APERTURE_CACHE_KEY ?? '').trim()
const stateDir = process.env.APERTURE_STATE_DIR ?? ''

// --- import the user script --------------------------------------------------

let userModule
try {
  const url = scriptArg.startsWith('file:') ? scriptArg : pathToFileURL(scriptArg).href
  userModule = await import(url)
} catch (err) {
  emitError(err?.message ?? String(err), err?.stack)
  process.exit(1)
}

// --- extract manifest --------------------------------------------------------

let manifest
try {
  manifest = extractManifest(userModule)
} catch (err) {
  if (err instanceof ManifestError) {
    emitError(err.message)
  } else {
    emitError(err?.message ?? String(err), err?.stack)
  }
  process.exit(1)
}

// --- launch-time params ------------------------------------------------------

const merged = mergeRawParams({
  query: queryFromSource(rawSource),
  flags: rawCliFlags,
})

const paramsResult = validateParams(manifest.schema, merged)
if (!paramsResult.ok) {
  const lines = paramsResult.issues.map((i) => `  ${i.path}: ${i.message}`).join('\n')
  emitError(`schema validation failed:\n${lines}`, null, {
    type: 'schema-validation',
    issues: paramsResult.issues,
  })
  process.exit(1)
}

runtime.__setParams(paramsResult.data)

// --- initial state -----------------------------------------------------------

const stateFilePath =
  cacheKey && stateDir ? join(stateDir, `${cacheKey}.json`) : null

let persistedSnapshot = null
if (stateFilePath) {
  try {
    const raw = await readFile(stateFilePath, 'utf8')
    persistedSnapshot = JSON.parse(raw)
  } catch (err) {
    // Missing / unreadable → falls back to defaults. A malformed snapshot
    // is logged so the developer can inspect.
    if (err?.code !== 'ENOENT') {
      runtime.log(
        `persisted state snapshot unreadable: ${err?.message ?? err}`,
        'warn',
      )
    }
  }
}

const initialState = buildInitialState({
  stateSchema: manifest.state,
  persistedSnapshot,
  validatedParams: paramsResult.data,
})

const store = new StateStore({
  stateSchema: manifest.state,
  initialValues: initialState,
  stateFilePath,
  emit,
  log: (msg, level = 'info', data) => runtime.log(msg, level, data),
})

runtime.__installStore(store)

// --- stdin wiring for GUI → script writes ------------------------------------

let exiting = false

async function callOnExit() {
  if (exiting) return
  exiting = true
  runtime.__abort('exit')
  const timer = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('onExit timed out after 5000ms')), 5000),
  )
  try {
    if (manifest.onExit) {
      await Promise.race([manifest.onExit(runtime), timer])
    }
  } catch (err) {
    emitError(err?.message ?? String(err), err?.stack)
    process.exit(1)
  }
  process.exit(0)
}

process.on('uncaughtException', (err) => {
  emitError(err?.message ?? String(err), err?.stack)
  process.exit(1)
})
process.on('unhandledRejection', (err) => {
  const e = err instanceof Error ? err : new Error(String(err))
  emitError(e.message, e.stack)
  process.exit(1)
})

const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let msg
  try {
    msg = JSON.parse(trimmed)
  } catch {
    // Ignore malformed stdin lines (complement of backend malformed-stdout
    // resilience).
    return
  }
  if (!msg || typeof msg !== 'object') return
  switch (msg.type) {
    case 'cancel':
      void callOnExit()
      return
    case 'state:set':
    case 'state:changed':
      if (typeof msg.key === 'string') {
        store.set(msg.key, msg.value, 'gui')
      }
      return
    default:
      // Other GUIEvent variants (call, invoke:result, …) are picked up in
      // Phases 4+.
      return
  }
})
rl.on('close', () => {
  void callOnExit()
})

// --- onLoad ------------------------------------------------------------------

if (manifest.onLoad) {
  try {
    const result = await manifest.onLoad(runtime.params, runtime)
    emit({ type: 'result', data: result === undefined ? null : result })
  } catch (err) {
    emitError(err?.message ?? String(err), err?.stack)
    process.exit(1)
  }
} else {
  emit({ type: 'result', data: null })
}

// Mirror initial state to the GUI once, so the frontend's shadow map starts
// in sync even for keys the script hasn't actively `set()`.
for (const [k, v] of Object.entries(initialState)) {
  // Streaming keys go through the chunked path for consistency.
  if (store.streamKeys.has(k)) {
    store.set(k, v, 'script')
  } else {
    emit({ type: 'state:set', key: k, value: v })
  }
}

// --- helpers -----------------------------------------------------------------

function emit(event) {
  process.stdout.write(JSON.stringify(event) + '\n')
}

function emitError(message, stack, extra) {
  const evt = { type: 'error', message }
  if (stack) evt.stack = stack
  if (extra) evt.data = extra
  try {
    process.stdout.write(JSON.stringify(evt) + '\n')
  } catch {
    // last-ditch — nothing to do if stdout is gone.
  }
}

function safeJson(raw) {
  if (typeof raw !== 'string' || raw === '') return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}
