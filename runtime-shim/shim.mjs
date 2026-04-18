// `aperture:runtime` — virtual module shim.
//
// Phase 1 surface: `progress` and `log` are real and emit valid NDJSON.
// Everything else is a typed stub that throws a clear "not implemented until
// Phase N" error when called — the design.md contract is visible to scripts
// so `import` statements don't fail, but calling a stubbed API surfaces the
// scope boundary loudly.

function emit(event) {
  // Writes one NDJSON line to stdout. The Tauri backend owns the pipe and
  // parses these per design.md §"Communication Architecture".
  const line = JSON.stringify(event)
  process.stdout.write(line + '\n')
}

// --- real in Phase 1 ---------------------------------------------------------

export function progress(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError('progress(value, label?) — value must be a finite number')
  }
  const evt = { type: 'progress', value }
  if (label !== undefined) evt.label = String(label)
  emit(evt)
}

export function log(message, level = 'info', data) {
  if (!['info', 'warn', 'error'].includes(level)) {
    throw new TypeError(`log(message, level?, data?) — level must be info|warn|error (got ${level})`)
  }
  const evt = { type: 'log', level, message: String(message) }
  if (data !== undefined) evt.data = data
  emit(evt)
}

// --- stubbed: real behavior arrives in later phases --------------------------

function notYet(name, phase) {
  return () => {
    throw new Error(
      `aperture:runtime.${name} is not implemented yet — landing in Phase ${phase}.`,
    )
  }
}

function stubObject(name, phase, keys) {
  const handler = {
    get(_t, prop) {
      if (prop === Symbol.toPrimitive || prop === 'toString') {
        return () => `[aperture:runtime.${name} — stub, Phase ${phase}]`
      }
      if (typeof prop === 'symbol') return undefined
      if (!keys.includes(prop)) return undefined
      return notYet(`${name}.${prop}`, phase)
    },
  }
  return new Proxy({}, handler)
}

export const state = stubObject('state', 2, [
  'set',
  'get',
  'setIn',
  'push',
  'watch',
  'persist',
])

export const invoke = notYet('invoke', 4)
export const invokeStream = notYet('invokeStream', 4)
export const on = notYet('on', 4)
export const createWorker = notYet('createWorker', 5)

// `params` is filled in by the bootstrap before the user script runs. It is a
// frozen object (or `{}` if no params were passed).
export let params = Object.freeze({})
export function __setParams(p) {
  params = Object.freeze({ ...(p ?? {}) })
}

// `signal` — Phase 1 exposes an AbortController so scripts that simply read
// `signal.aborted` work. The signal *never fires* in Phase 1; cancellation /
// timeout wiring lands in Phase 4.
const controller = new AbortController()
export const signal = controller.signal
export function __abort(reason) {
  controller.abort(reason)
}
