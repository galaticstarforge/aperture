// @aperture-version 0.1.0
//
// Acceptance criterion #3 — `runtime.log(...)` emits a structured NDJSON line
// on stdout that the Tauri backend parses and forwards to the frontend.

import { log } from 'aperture:runtime'

export async function onLoad() {
  log('hi from log.mjs', 'info', { when: new Date().toISOString() })
}
