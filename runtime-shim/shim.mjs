// `aperture:runtime` — virtual module shim.
//
// Phase 4 surface:
//   - `invoke(fn, args)`        — real; emits invoke event, awaits invoke:result
//   - `invokeStream(fn, args)`  — real; async generator over invoke:stream chunks
//   - `on`                      — stub (Phase 5)
//   - `createWorker`            — stub (Phase 5)
//
// Earlier surfaces remain unchanged:
//   - `progress`, `log`         — real (NDJSON over stdout)
//   - `state`                   — real reactive store
//   - `params`                  — frozen launch-time snapshot
//   - `signal`                  — AbortSignal wired to cancel/exit

import './schema-markers.mjs'
import { install as installSchemaMarkers } from './schema-markers.mjs'

installSchemaMarkers()

function emit(event) {
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

// Exposes the controller so Phase 5 worker harness can subscribe.
export const __abortController = controller

// --- invoke / invokeStream ---------------------------------------------------

let _callSeq = 0
function nextCallId() {
  return `inv-${Date.now()}-${++_callSeq}`
}

// Pending invoke promises: callId → { resolve, reject }
const _pendingInvokes = new Map()
// Pending stream controllers: callId → { push(chunk, final), abort(err) }
const _pendingStreams = new Map()

export function __resolveInvoke(callId, result) {
  const pending = _pendingInvokes.get(callId)
  if (pending) {
    _pendingInvokes.delete(callId)
    pending.resolve(result)
  }
}

export function __rejectInvoke(callId, errorMsg) {
  const pending = _pendingInvokes.get(callId)
  if (pending) {
    _pendingInvokes.delete(callId)
    pending.reject(new Error(errorMsg))
  }
}

export function __pushStreamChunk(callId, chunk, isFinal) {
  const pending = _pendingStreams.get(callId)
  if (pending) {
    pending.push(chunk, isFinal)
    if (isFinal) _pendingStreams.delete(callId)
  }
}

export function __abortStream(callId, errorMsg) {
  const pending = _pendingStreams.get(callId)
  if (pending) {
    _pendingStreams.delete(callId)
    pending.abort(new Error(errorMsg))
  }
}

export function invoke(fn, args = {}) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException(String(signal.reason ?? 'Aborted'), 'AbortError'))
      return
    }
    const callId = nextCallId()
    _pendingInvokes.set(callId, { resolve, reject })

    const onAbort = () => {
      if (_pendingInvokes.has(callId)) {
        _pendingInvokes.delete(callId)
        reject(new DOMException(String(signal.reason ?? 'Aborted'), 'AbortError'))
      }
    }
    signal.addEventListener('abort', onAbort, { once: true })

    emit({ type: 'invoke', fn, args, callId })
  })
}

export async function* invokeStream(fn, args = {}) {
  if (signal.aborted) {
    throw new DOMException(String(signal.reason ?? 'Aborted'), 'AbortError')
  }

  const callId = nextCallId()

  // Queue-based async generator: chunks arrive asynchronously via
  // __pushStreamChunk; the generator waits on a Promise that is replaced
  // each time the queue drains.
  const queue = []
  let done = false
  let streamError = null
  let notify = null   // resolves the current "wait for more" promise

  _pendingStreams.set(callId, {
    push(chunk, isFinal) {
      queue.push(chunk)
      if (isFinal) done = true
      if (notify) { const n = notify; notify = null; n() }
    },
    abort(err) {
      streamError = err
      done = true
      if (notify) { const n = notify; notify = null; n() }
    },
  })

  const onAbort = () => {
    if (_pendingStreams.has(callId)) {
      _pendingStreams.delete(callId)
      streamError = new DOMException(String(signal.reason ?? 'Aborted'), 'AbortError')
      done = true
      if (notify) { const n = notify; notify = null; n() }
    }
  }
  signal.addEventListener('abort', onAbort, { once: true })

  try {
    emit({ type: 'invoke', fn, args, callId, stream: true })

    while (!done || queue.length > 0) {
      while (queue.length > 0) {
        yield queue.shift()
      }
      if (!done) {
        await new Promise((r) => { notify = r })
      }
    }

    if (streamError) throw streamError
  } finally {
    signal.removeEventListener('abort', onAbort)
    _pendingStreams.delete(callId)
  }
}

// --- format request / result -------------------------------------------------
// Custom formatters run in the child; the frontend dispatches format:request
// and receives format:result.  Bootstrap routes these events.

const _pendingFormats = new Map()  // callId → { resolve, reject }
let _formatSeq = 0

export function __resolveFormat(callId, result) {
  const pending = _pendingFormats.get(callId)
  if (pending) {
    _pendingFormats.delete(callId)
    pending.resolve(result)
  }
}

export function __rejectFormat(callId, errorMsg) {
  const pending = _pendingFormats.get(callId)
  if (pending) {
    _pendingFormats.delete(callId)
    pending.reject(new Error(errorMsg))
  }
}

// Called by bootstrap when a format:request arrives on stdin.
export function __handleFormatRequest(name, value, context, callId, formatters) {
  const fn = formatters?.[name]
  if (!fn || typeof fn !== 'function') {
    emit({ type: 'format:result', callId, error: `Unknown formatter: ${name}` })
    return
  }
  Promise.resolve()
    .then(() => fn(value, context))
    .then((result) => emit({ type: 'format:result', callId, result }))
    .catch((err) =>
      emit({ type: 'format:result', callId, error: err?.message ?? String(err) }),
    )
}

// --- on (Phase 5 stub) -------------------------------------------------------

export function on() {
  throw new Error(
    `aperture:runtime.on is not implemented yet — landing in Phase 5.`,
  )
}

// --- createWorker (Phase 5 stub) ---------------------------------------------

export function createWorker() {
  throw new Error(
    `aperture:runtime.createWorker is not implemented yet — landing in Phase 5.`,
  )
}
