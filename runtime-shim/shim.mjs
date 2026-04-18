// `aperture:runtime` — virtual module shim.
//
// Phase 2 surface:
//   - `progress`, `log`        — real (NDJSON over stdout)
//   - `state`                  — real reactive store (set/get/setIn/push/
//                                watch/persist); backed by a StateStore
//                                instance installed by the bootstrap
//   - `params`                 — frozen launch-time snapshot set by bootstrap
//   - `signal`                 — AbortSignal wired to cancel/exit
//   - `invoke`, `invokeStream`, `on`, `createWorker` — stubs that throw,
//     landing in Phases 4/5.
//
// The shim installs zod `.persist()` / `.stream()` prototype extensions at
// load-time so user schemas written as `z.string().persist()` work without
// any extra import.

import './schema-markers.mjs'
import { install as installSchemaMarkers } from './schema-markers.mjs'

installSchemaMarkers()

function emit(event) {
  // Writes one NDJSON line to stdout. The Tauri backend owns the pipe.
  const line = JSON.stringify(event)
  process.stdout.write(line + '\n')
}

// --- progress / log ----------------------------------------------------------

export function progress(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError('progress(value, label?) — value must be a finite number')
  }
  const evt = { type: 'progress', value }
  if (label !== undefined) evt.label = String(label)
  emit(evt)
}

export function log(message, level = 'info', data) {
  if (!['info', 'warn', 'error', 'debug'].includes(level)) {
    throw new TypeError(
      `log(message, level?, data?) — level must be info|warn|error|debug (got ${level})`,
    )
  }
  // `debug` is folded into `info` on the wire until the log panel learns
  // richer levels (Phase 3/4).
  const wireLevel = level === 'debug' ? 'info' : level
  const evt = { type: 'log', level: wireLevel, message: String(message) }
  if (data !== undefined) evt.data = data
  emit(evt)
}

// --- state -------------------------------------------------------------------

let store = null

/**
 * Installed once by the bootstrap after schema extraction + params validation.
 * The object returned by `state` delegates to this live store; calling state
 * methods before installation throws with a clear phase error.
 */
export function __installStore(s) {
  store = s
}

function requireStore(method) {
  if (!store) {
    throw new Error(
      `aperture:runtime.state.${method} called before the store was initialized. ` +
        `This usually means the script body (not just onLoad) touched state — ` +
        `move the call into onLoad or a later callback.`,
    )
  }
  return store
}

export const state = Object.freeze({
  set(key, value) {
    return requireStore('set').set(key, value, 'script')
  },
  get(key) {
    return requireStore('get').get(key)
  },
  setIn(path, value) {
    return requireStore('setIn').setIn(path, value)
  },
  push(key, item) {
    return requireStore('push').push(key, item)
  },
  watch(key, handler) {
    return requireStore('watch').watch(key, handler)
  },
  persist() {
    return requireStore('persist').persist()
  },
})

// --- params ------------------------------------------------------------------

export let params = Object.freeze({})
export function __setParams(p) {
  params = Object.freeze({ ...(p ?? {}) })
}

// --- signal / cancellation ---------------------------------------------------

const controller = new AbortController()
export const signal = controller.signal
export function __abort(reason) {
  controller.abort(reason)
}

// --- stubbed: real behavior arrives in later phases --------------------------

function notYet(name, phase) {
  return () => {
    throw new Error(
      `aperture:runtime.${name} is not implemented yet — landing in Phase ${phase}.`,
    )
  }
}

export const invoke = notYet('invoke', 4)
export const invokeStream = notYet('invokeStream', 4)
export const on = notYet('on', 4)
export const createWorker = notYet('createWorker', 5)
