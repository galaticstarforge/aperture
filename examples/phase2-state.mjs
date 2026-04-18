// @aperture-version 0.1.0
//
// Phase 2 smoke script — exercises the schema + state + watch surface.
// Launch with:
//   aperture ./examples/phase2-state.mjs "$PWD" --targetDir ./src --dryRun true
//
// Observable outcomes (visible in the dev-tools console):
//   - `[launch]` message shows the raw flags
//   - `[state:set]` lines appear as the script writes state
//   - `[script:info] threshold changed …` fires whenever you drive the
//     threshold key from the dev console, e.g.
//       > window.__aperture.setState('threshold', 80)

import { z } from 'zod'

export const schema = z.object({
  targetDir: z.string().default('./src').describe('Root directory to scan'),
  dryRun: z.boolean().default(true).describe('Preview without writing'),
})

export const state = z.object({
  status: z.string().default('idle').persist(),
  threshold: z.number().default(50).persist(),
  counter: z.number().default(0),
  events: z.array(z.any()).default([]),
  bigReport: z.any().default(null).stream(),
})

export async function onLoad(params, runtime) {
  runtime.log(`Loaded with targetDir=${params.targetDir} dryRun=${params.dryRun}`, 'info')
  runtime.state.set('status', `Ready — targeting ${params.targetDir}`)

  // Canonical reactivity pattern — fires on ANY write, any origin.
  runtime.state.watch('threshold', (v) => {
    runtime.log(`threshold changed → ${v}`, 'info')
  })

  // Tick a non-persisted counter once a second so the GUI has something to
  // see without user input. Stops on signal.aborted (wired via onExit).
  const tick = setInterval(() => {
    if (runtime.signal.aborted) {
      clearInterval(tick)
      return
    }
    const next = (runtime.state.get('counter') ?? 0) + 1
    runtime.state.set('counter', next)
  }, 1000)
}

export async function onExit(runtime) {
  // Acceptance criterion #8 — persistKeys survive across restarts.
  await runtime.state.persist()
}
