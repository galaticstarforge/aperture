// Phase 4 child-process bootstrap.
//
// Responsibilities layered on top of Phase 2/3:
//   - Route `invoke:result` / `invoke:stream` stdin messages to shim resolvers
//   - Route `format:request` stdin messages to the shim formatter handler
//   - Wire `call` handler with `meta.returnsInto` auto-write
//   - Propagate `cancel` reason through to __abort
//   - Extract `timeoutMs` from user module; arm a Node timeout if set
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

// --- emit manifest event -----------------------------------------------------

const currentStateSnapshot = () => Object.fromEntries(store.values)

const isUiFn = typeof manifest.ui === 'function'
const initialUiTree = isUiFn
  ? (() => {
      try {
        return manifest.ui(currentStateSnapshot(), paramsResult.data)
      } catch {
        return {}
      }
    })()
  : manifest.ui

emit({
  type: 'manifest',
  ui: initialUiTree,
  window: manifest.window,
  callbacks: Object.keys(manifest.callbacks),
  formatters: Object.keys(manifest.formatters ?? {}),
  timeoutMs: typeof manifest.timeoutMs === 'number' ? manifest.timeoutMs : null,
})

// For function-form ui, re-emit the tree on any state change via a debounced
// microtask so rapid multi-key writes collapse into one emission.
if (isUiFn) {
  let uiUpdatePending = false
  const scheduleUiUpdate = () => {
    if (uiUpdatePending) return
    uiUpdatePending = true
    queueMicrotask(() => {
      uiUpdatePending = false
      try {
        emit({ type: 'ui:update', tree: manifest.ui(currentStateSnapshot(), paramsResult.data) })
      } catch {
        // Swallow — a bad ui function shouldn't crash the process.
      }
    })
  }
  if (manifest.state) {
    const shape =
      typeof manifest.state._def?.shape === 'function'
        ? manifest.state._def.shape()
        : typeof manifest.state.shape === 'function'
          ? manifest.state.shape()
          : manifest.state._def?.shape ?? {}
    for (const key of Object.keys(shape ?? {})) {
      store.watch(key, scheduleUiUpdate)
    }
  }
}

// --- hard timeout (export const timeoutMs) -----------------------------------

const scriptTimeoutMs =
  typeof userModule.timeoutMs === 'number' && userModule.timeoutMs > 0
    ? userModule.timeoutMs
    : null

if (scriptTimeoutMs) {
  const t = setTimeout(() => {
    void callOnExit('timeout')
  }, scriptTimeoutMs)
  // Don't let the timer keep the process alive past natural exit.
  if (typeof t.unref === 'function') t.unref()
}

// --- stdin wiring for GUI → script writes ------------------------------------

let exiting = false

async function callOnExit(reason = 'exit') {
  if (exiting) return
  exiting = true
  runtime.__abort(reason)
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
    return
  }
  if (!msg || typeof msg !== 'object') return
  switch (msg.type) {
    case 'cancel':
      void callOnExit(msg.reason ?? 'cancelled')
      return

    case 'state:set':
    case 'state:changed':
      if (typeof msg.key === 'string') {
        store.set(msg.key, msg.value, 'gui')
      }
      return

    case 'invoke:result': {
      const { callId, result, error } = msg
      if (typeof callId !== 'string') return
      if (error) {
        runtime.__rejectInvoke(callId, String(error))
      } else {
        runtime.__resolveInvoke(callId, result)
      }
      return
    }

    case 'invoke:stream': {
      const { callId, chunk, final: isFinal, error } = msg
      if (typeof callId !== 'string') return
      if (error) {
        runtime.__abortStream(callId, String(error))
      } else {
        runtime.__pushStreamChunk(callId, chunk, Boolean(isFinal))
      }
      return
    }

    case 'format:request': {
      const { callId, name, value, context } = msg
      if (typeof callId !== 'string' || typeof name !== 'string') return
      runtime.__handleFormatRequest(name, value, context ?? {}, callId, manifest.formatters)
      return
    }

    case 'call': {
      const fn = typeof msg.fn === 'string' ? manifest.callbacks[msg.fn] : null
      if (!fn) {
        if (typeof msg.fn === 'string') {
          runtime.log(`callback not found: ${msg.fn}`, 'warn')
        }
        return
      }
      const fnName = msg.fn
      void Promise.resolve()
        .then(() => fn(msg.args ?? {}, runtime))
        .then(async (result) => {
          const fnMeta = manifest.meta?.[fnName]
          if (fnMeta?.returnsInto) {
            store.set(fnMeta.returnsInto, result, 'script')
          }
        })
        .catch((err) => {
          // AbortError from a cancelled invoke inside a callback is not fatal.
          if (runtime.signal.aborted && err?.name === 'AbortError') {
            runtime.log(`callback ${fnName} aborted`, 'warn')
            return
          }
          emitError(err?.message ?? String(err), err?.stack)
        })
      return
    }

    default:
      return
  }
})
rl.on('close', () => {
  void callOnExit('window-close')
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

// Mirror initial state to the GUI once.
for (const [k, v] of Object.entries(initialState)) {
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
