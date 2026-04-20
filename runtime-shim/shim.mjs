// `aperture:runtime` — virtual module shim.
//
// Phase 5 surface:
//   - `createWorker(fn, { name })` — real; spawns a Node worker_threads Worker
//   - `on(event, handler)`         — real; subscribe to runtime events
//
// Phase 4 surfaces remain unchanged.
// Earlier surfaces remain unchanged.

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

// Active logTarget hooks: stateKey → true. Populated by bootstrap scanning UI.
const _logTargetKeys = new Set()

export function __addLogTarget(key) {
  _logTargetKeys.add(key)
}

export function log(message, level = 'info', data) {
  if (!['info', 'warn', 'error', 'debug'].includes(level)) {
    throw new TypeError(
      `log(message, level?, data?) — level must be info|warn|error|debug (got ${level})`,
    )
  }
  const wireLevel = level === 'debug' ? 'info' : level
  const evt = { type: 'log', level: wireLevel, message: String(message) }
  if (data !== undefined) evt.data = data
  emit(evt)

  // Append to any logTarget state keys registered by timeline elements.
  if (_logTargetKeys.size > 0 && store) {
    const entry = {
      id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: Date.now(),
      level: wireLevel,
      message: String(message),
      ...(data !== undefined ? { data } : {}),
      source: 'main',
    }
    for (const key of _logTargetKeys) {
      const cur = store.get(key)
      const arr = Array.isArray(cur) ? cur.slice() : []
      arr.push(entry)
      store.set(key, arr, 'script')
    }
  }
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

export const __abortController = controller

// --- invoke / invokeStream ---------------------------------------------------

let _callSeq = 0
function nextCallId() {
  return `inv-${Date.now()}-${++_callSeq}`
}

const _pendingInvokes = new Map()
const _pendingStreams = new Map()

// Headless-mode guard. `aperture run` sets APERTURE_HEADLESS=1; in that mode
// we reject the GUI-only invoke targets with 'not-available-headless' so
// scripts fail fast instead of dead-locking waiting for a response. Previously
// bootstrap tried to rewrite `runtime.invoke` via Object.defineProperty on the
// ESM namespace, which is non-configurable under Node 22 and broke at startup.
const _IS_HEADLESS = process.env.APERTURE_HEADLESS === '1'
const _HEADLESS_GUI_ONLY = new Set(['filePicker', 'confirm', 'prompt', 'notification'])

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
  if (_IS_HEADLESS && _HEADLESS_GUI_ONLY.has(fn)) {
    return Promise.reject(new Error('not-available-headless'))
  }
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException(String(signal.reason ?? 'Aborted'), 'AbortError'))
      return
    }
    const callId = nextCallId()
    const onAbort = () => {
      if (_pendingInvokes.has(callId)) {
        _pendingInvokes.delete(callId)
        reject(new DOMException(String(signal.reason ?? 'Aborted'), 'AbortError'))
      }
    }
    // Wrap resolve/reject so the abort listener is removed on normal settlement.
    // Without this, each invoke leaks a listener closure until abort fires.
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    _pendingInvokes.set(callId, {
      resolve: (v) => { cleanup(); resolve(v) },
      reject: (e) => { cleanup(); reject(e) },
    })
    signal.addEventListener('abort', onAbort, { once: true })

    emit({ type: 'invoke', fn, args, callId })
  })
}

export async function* invokeStream(fn, args = {}) {
  if (signal.aborted) {
    throw new DOMException(String(signal.reason ?? 'Aborted'), 'AbortError')
  }

  const callId = nextCallId()

  const queue = []
  let done = false
  let streamError = null
  let notify = null

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

const _pendingFormats = new Map()

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

// --- on (runtime event subscriptions) ----------------------------------------

const _runtimeHandlers = new Map()

export function on(event, handler) {
  if (typeof event !== 'string') throw new TypeError('runtime.on(event, handler) — event must be a string')
  if (typeof handler !== 'function') throw new TypeError('runtime.on(event, handler) — handler must be a function')
  let set = _runtimeHandlers.get(event)
  if (!set) { set = new Set(); _runtimeHandlers.set(event, set) }
  set.add(handler)
  return () => {
    const s = _runtimeHandlers.get(event)
    if (s) { s.delete(handler); if (s.size === 0) _runtimeHandlers.delete(event) }
  }
}

function _fireRuntimeEvent(event, data) {
  const set = _runtimeHandlers.get(event)
  if (set) for (const h of set) { try { h(data) } catch {} }
}

// --- createWorker ------------------------------------------------------------

const _liveWorkers = new Set()

// Wire abort → terminate all live workers.
controller.signal.addEventListener('abort', () => {
  for (const w of _liveWorkers) {
    try { w.terminate() } catch {}
  }
  _liveWorkers.clear()
})

let _workerSeq = 0
let _workerTmpDir = null

export function __initWorkerTmpDir(dir) {
  _workerTmpDir = dir
}

// Phase 5 seam for the Phase 6 static analyzer.
// eslint-disable-next-line no-unused-vars
function _analyzeWorkerFn(_fnSource) {
  // Always-off in Phase 5.
}

async function _ensureWorkerTmpDir() {
  if (_workerTmpDir) return _workerTmpDir
  const os = await import('node:os')
  const path = await import('node:path')
  const dir = path.join(os.homedir(), '.aperture', 'logs', 'worker-tmp')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(dir, { recursive: true })
  _workerTmpDir = dir
  return dir
}

export function createWorker(fn, options = {}) {
  // Flat hierarchy guard: workers cannot spawn workers.
  if (process.env.__APERTURE_WORKER === '1') {
    throw new Error(
      'aperture:runtime.createWorker cannot be called inside a worker (flat hierarchy guard).',
    )
  }

  if (typeof fn !== 'function') {
    throw new TypeError('createWorker(fn, options) — fn must be a function')
  }

  const name = String(options?.name ?? `worker-${++_workerSeq}`)
  _analyzeWorkerFn(fn.toString())

  const _handlers = new Map()

  function workerOn(event, handler) {
    if (typeof event !== 'string') throw new TypeError('worker.on(event, handler) — event must be a string')
    if (typeof handler !== 'function') throw new TypeError('worker.on(event, handler) — handler must be a function')
    let set = _handlers.get(event)
    if (!set) { set = new Set(); _handlers.set(event, set) }
    set.add(handler)
    return () => {
      const s = _handlers.get(event)
      if (s) { s.delete(handler); if (s.size === 0) _handlers.delete(event) }
    }
  }

  function _fireWorkerEvent(event, data) {
    const set = _handlers.get(event)
    if (set) for (const h of set) { try { h(data) } catch {} }
    _fireRuntimeEvent(event, data)
  }

  function run(data) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException('Aborted', 'AbortError'))
        return
      }

      // Spin up asynchronously (file write + Worker spawn).
      _spawnWorker(fn, name, data, _fireWorkerEvent, resolve, reject)
    })
  }

  return { run, on: workerOn }
}

async function _spawnWorker(fn, name, data, fireWorkerEvent, resolve, reject) {
  let tmpFile = null
  let worker = null

  try {
    const tmpDir = await _ensureWorkerTmpDir()
    const { join } = await import('node:path')
    const { writeFile, rm } = await import('node:fs/promises')
    const { Worker } = await import('worker_threads')

    const id = `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    tmpFile = join(tmpDir, `${id}.mjs`)

    const fnSource = fn.toString()
    const workerSource = _buildWorkerSource(fnSource, name)
    await writeFile(tmpFile, workerSource, 'utf8')

    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }

    worker = new Worker(tmpFile, {
      workerData: { __name: name, userData: data },
      env: { ...process.env, __APERTURE_WORKER: '1' },
    })

    _liveWorkers.add(worker)

    const onAbort = () => {
      try { worker.terminate() } catch {}
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })

    worker.on('message', (msg) => {
      if (!msg || typeof msg !== 'object') return

      if (msg.type === '__done__') {
        cleanup()
        resolve(msg.data)
        return
      }
      if (msg.type === '__error__') {
        cleanup()
        const err = new Error(msg.data?.message ?? String(msg.data))
        if (msg.data?.stack) err.stack = msg.data.stack
        reject(err)
        return
      }
      if (msg.type === 'state:get') {
        // Worker requests a state value; reply immediately from the main store.
        const value = store ? store.get(msg.key) : undefined
        try { worker.postMessage({ type: 'state:get:reply', callId: msg.callId, value }) } catch {}
        return
      }
      if (msg.type === 'state:set') {
        // Worker emit('state:set', { key, value }) puts payload in msg.data.
        const key = msg.data?.key ?? msg.key
        const value = msg.data !== undefined ? msg.data.value : msg.value
        if (store && typeof key === 'string') {
          store.set(key, value, 'script')
        }
      }

      // Fan out to subscribers, stamping source.
      const tagged = { ...msg, source: msg.source ?? name }
      fireWorkerEvent(msg.type, tagged)
      if (msg.type === 'log') {
        emit({ type: 'log', level: tagged.level ?? 'info', message: String(tagged.message ?? ''), source: name })
      }
    })

    worker.on('error', (err) => {
      cleanup()
      reject(err)
    })

    worker.on('exit', (code) => {
      cleanup()
      // Only reject on non-zero exit if __done__/__error__ wasn't already sent.
    })

    function cleanup() {
      signal.removeEventListener('abort', onAbort)
      _liveWorkers.delete(worker)
      // Delete temp file asynchronously; errors are non-fatal.
      if (tmpFile) {
        import('node:fs/promises').then(({ rm }) => rm(tmpFile, { force: true }).catch(() => {}))
        tmpFile = null
      }
    }
  } catch (err) {
    reject(err)
  }
}

function _buildWorkerSource(fnSource, name) {
  // Produces a .mjs file (ESM) that embeds the user function and bootstrap.
  return `import { workerData, parentPort } from 'worker_threads';

const __name = workerData.__name ?? ${JSON.stringify(name)};

const __pendingGets = new Map();
let __getSeq = 0;

function emit(event, data) {
  parentPort.postMessage({ type: event, data, source: __name, message: data?.message, level: data?.level });
}

function get(key) {
  return new Promise((resolve, reject) => {
    const callId = 'sg-' + (++__getSeq);
    __pendingGets.set(callId, { resolve, reject });
    parentPort.postMessage({ type: 'state:get', key, callId, source: __name });
    setTimeout(() => {
      if (__pendingGets.has(callId)) {
        __pendingGets.delete(callId);
        reject(new Error('state:get timed out for key: ' + key));
      }
    }, 5000);
  });
}

parentPort.on('message', (msg) => {
  if (msg && msg.type === 'state:get:reply') {
    const pending = __pendingGets.get(msg.callId);
    if (pending) {
      __pendingGets.delete(msg.callId);
      pending.resolve(msg.value);
    }
  }
});

const __fn = ${fnSource};

Promise.resolve()
  .then(() => __fn(workerData.userData, { emit, get }))
  .then((result) => parentPort.postMessage({ type: '__done__', data: result, source: __name }))
  .catch((err) => parentPort.postMessage({
    type: '__error__',
    data: { message: err?.message ?? String(err), stack: err?.stack },
    source: __name,
  }));
`
}
