// Phase 1 child-process bootstrap.
//
// Invocation shape (from the Tauri backend):
//
//   node --import file:///.../runtime-shim/loader.mjs \
//        /.../runtime-shim/bootstrap.mjs \
//        /absolute/path/to/user/script.mjs
//
// Env: APERTURE_SCRIPT (absolute script path), APERTURE_PARAMS (JSON object).
//
// Phase 1 responsibilities:
//   - Import the user script as an ESM module
//   - Set `runtime.params` from APERTURE_PARAMS
//   - Call `onLoad(params, runtime)` if exported
//   - Keep the process alive for interactive use
//   - On uncaught error, emit a structured `error` NDJSON event and exit 1
//   - On stdin EOF or {"type":"cancel"}, run `onExit(runtime)` with a 5s
//     budget, then exit
//
// Later phases layer state/invoke/worker plumbing on top of this skeleton.

import { pathToFileURL } from 'node:url'
import { createInterface } from 'node:readline'
import * as runtime from 'aperture:runtime'

const scriptArg = process.argv[2] ?? process.env.APERTURE_SCRIPT
if (!scriptArg) {
  emitError('bootstrap: APERTURE_SCRIPT not set')
  process.exit(1)
}

let paramsObj = {}
try {
  paramsObj = JSON.parse(process.env.APERTURE_PARAMS ?? '{}') ?? {}
} catch (err) {
  emitError(`bootstrap: failed to parse APERTURE_PARAMS: ${err.message}`)
  process.exit(1)
}

runtime.__setParams(paramsObj)

let userModule
try {
  const url = scriptArg.startsWith('file:') ? scriptArg : pathToFileURL(scriptArg).href
  userModule = await import(url)
} catch (err) {
  emitError(err.message ?? String(err), err.stack)
  process.exit(1)
}

// --- lifecycle ---------------------------------------------------------------

let exiting = false

async function callOnExit() {
  if (exiting) return
  exiting = true
  runtime.__abort('exit')
  const timer = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('onExit timed out after 5000ms')), 5000),
  )
  try {
    if (typeof userModule.onExit === 'function') {
      await Promise.race([userModule.onExit(runtime), timer])
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

// Wire stdin — the backend sends a `{"type":"cancel"}` line on window close.
const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  try {
    const msg = JSON.parse(trimmed)
    if (msg && msg.type === 'cancel') {
      void callOnExit()
    }
    // All other GUIEvent variants are swallowed in Phase 1; Phase 2+ wire them.
  } catch {
    // Ignore malformed stdin lines — this is the complement of the malformed
    // stdout behavior on the backend. Phase 1 prefers resilience to strictness.
  }
})
rl.on('close', () => {
  // Stdin closed — backend wants us to exit.
  void callOnExit()
})

// --- onLoad ------------------------------------------------------------------

if (typeof userModule.onLoad === 'function') {
  try {
    const result = await userModule.onLoad(runtime.params, runtime)
    emit({ type: 'result', data: result === undefined ? null : result })
  } catch (err) {
    emitError(err?.message ?? String(err), err?.stack)
    process.exit(1)
  }
} else {
  emit({ type: 'result', data: null })
}

// --- helpers -----------------------------------------------------------------

function emit(event) {
  process.stdout.write(JSON.stringify(event) + '\n')
}

function emitError(message, stack) {
  const evt = { type: 'error', message }
  if (stack) evt.stack = stack
  try {
    process.stdout.write(JSON.stringify(evt) + '\n')
  } catch {
    // last-ditch — if stdout is gone there's nothing we can do.
  }
}
