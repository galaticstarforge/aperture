import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { install } from '../schema-markers.mjs'
import {
  extractManifest,
  buildInitialState,
  ManifestError,
} from '../manifest.mjs'

install()

test('extractManifest enforces zod on schema/state', () => {
  assert.throws(() => extractManifest({ schema: { not: 'zod' } }), ManifestError)
  assert.throws(() => extractManifest({ state: 42 }), ManifestError)
})

test('extractManifest collects callbacks but excludes reserved names', () => {
  const m = extractManifest({
    onLoad: () => {},
    onExit: () => {},
    myCallback: () => {},
    another: () => {},
    schema: z.object({}),
  })
  assert.deepEqual(Object.keys(m.callbacks).sort(), ['another', 'myCallback'])
  assert.equal(typeof m.onLoad, 'function')
})

test('buildInitialState layers defaults → persist → params', () => {
  const stateSchema = z.object({
    targetDir: z.string().default('./src').persist(),
    threshold: z.number().default(50).persist(),
    events: z.array(z.any()).default([]),
  })
  const persistedSnapshot = { threshold: 77 } // only 1 persisted key survived
  const validatedParams = { targetDir: './from-cli', unrelated: 1 }
  const out = buildInitialState({ stateSchema, persistedSnapshot, validatedParams })
  assert.equal(out.targetDir, './from-cli') // params overlay wins
  assert.equal(out.threshold, 77) // persisted wins over default
  assert.deepEqual(out.events, [])
  // unrelated param does NOT bleed into state (no state key of that name).
  assert.equal('unrelated' in out, false)
})

test('buildInitialState with no persisted snapshot reverts to defaults', () => {
  const stateSchema = z.object({
    threshold: z.number().default(50).persist(),
  })
  const out = buildInitialState({ stateSchema, persistedSnapshot: null, validatedParams: {} })
  assert.equal(out.threshold, 50)
})
