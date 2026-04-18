// @aperture-version 0.1.0
//
// Acceptance criterion #2 — an uncaught throw inside onLoad replaces the
// window with the full-screen death screen.

export async function onLoad() {
  throw new Error('Demo crash from throw.mjs — this should land on the death screen.')
}
