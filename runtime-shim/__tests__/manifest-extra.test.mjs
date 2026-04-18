// Additional edge-case tests for manifest.mjs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { install } from '../schema-markers.mjs'
import { extractManifest, buildInitialState, ManifestError } from '../manifest.mjs'

install()

// ---------------------------------------------------------------------------
// extractManifest — optional fields
// ---------------------------------------------------------------------------

test('extractManifest returns null for missing schema and state', () => {
  const m = extractManifest({})
  assert.equal(m.schema, null)
  assert.equal(m.state, null)
})

test('extractManifest returns null for missing onLoad and onExit', () => {
  const m = extractManifest({})
  assert.equal(m.onLoad, null)
  assert.equal(m.onExit, null)
})

test('extractManifest captures headless function', () => {
  const headless = async () => {}
  const m = extractManifest({ headless })
  assert.equal(m.headless, headless)
})

test('extractManifest returns null headless when absent', () => {
  const m = extractManifest({})
  assert.equal(m.headless, null)
})

test('extractManifest excludes headless from callbacks', () => {
  const m = extractManifest({ headless: async () => {}, extra: () => {} })
  assert.ok('extra' in m.callbacks)
  assert.ok(!('headless' in m.callbacks))
})

test('extractManifest collects deps array', () => {
  const m = extractManifest({ deps: ['lodash', 'zod'] })
  assert.deepEqual(m.deps, ['lodash', 'zod'])
})

test('extractManifest defaults deps to [] for non-array', () => {
  assert.deepEqual(extractManifest({ deps: 'lodash' }).deps, [])
  assert.deepEqual(extractManifest({ deps: null }).deps, [])
  assert.deepEqual(extractManifest({}).deps, [])
})

test('extractManifest collects env array', () => {
  const m = extractManifest({ env: ['HOME', 'PATH'] })
  assert.deepEqual(m.env, ['HOME', 'PATH'])
})

test('extractManifest defaults env to [] for non-array', () => {
  assert.deepEqual(extractManifest({ env: 'HOME' }).env, [])
  assert.deepEqual(extractManifest({}).env, [])
})

test('extractManifest collects window config object', () => {
  const m = extractManifest({ window: { width: 800, title: 'My App' } })
  assert.deepEqual(m.window, { width: 800, title: 'My App' })
})

test('extractManifest defaults window to {} for non-plain-object', () => {
  assert.deepEqual(extractManifest({ window: [1, 2] }).window, {})
  assert.deepEqual(extractManifest({ window: null }).window, {})
  assert.deepEqual(extractManifest({}).window, {})
})

test('extractManifest collects formatters object', () => {
  const fmt = { date: (v) => String(v) }
  const m = extractManifest({ formatters: fmt })
  assert.equal(m.formatters, fmt)
})

test('extractManifest defaults formatters to {} for non-plain-object', () => {
  assert.deepEqual(extractManifest({ formatters: 'bad' }).formatters, {})
  assert.deepEqual(extractManifest({}).formatters, {})
})

test('extractManifest collects meta object', () => {
  const meta = { author: 'Alice', version: '1.0' }
  const m = extractManifest({ meta })
  assert.deepEqual(m.meta, meta)
})

test('extractManifest defaults meta to {} for non-plain-object', () => {
  assert.deepEqual(extractManifest({ meta: 42 }).meta, {})
  assert.deepEqual(extractManifest({}).meta, {})
})

test('extractManifest throws ManifestError for schema=string', () => {
  assert.throws(() => extractManifest({ schema: 'z.object({})' }), ManifestError)
})

test('extractManifest throws ManifestError for state=number', () => {
  assert.throws(() => extractManifest({ state: 42 }), ManifestError)
})

test('extractManifest throws ManifestError for state=array', () => {
  assert.throws(() => extractManifest({ state: [] }), ManifestError)
})

test('extractManifest error message names the bad type for schema', () => {
  let msg = ''
  try {
    extractManifest({ schema: [] })
  } catch (e) {
    msg = e.message
  }
  assert.match(msg, /array/)
})

test('extractManifest excludes all reserved export names from callbacks', () => {
  // schema and state must be undefined or real zod schemas — functions would
  // fail the isZodSchema check and throw ManifestError. Use valid values.
  const reserved = {
    onLoad: () => {},
    onExit: () => {},
    headless: () => {},
    // Non-function reserved names (deps, env, window, schema, state, ui,
    // formatters, meta, default) are filtered by name even if they're functions
    // in unexpected positions — but schema/state must satisfy isZodSchema or be
    // undefined to avoid ManifestError.
    schema: z.object({}),
    state: z.object({}),
    ui: {},
    meta: {},
    default: () => {},
    myCallback: () => {},
    anotherCb: () => {},
  }
  const m = extractManifest(reserved)
  assert.deepEqual(Object.keys(m.callbacks).sort(), ['anotherCb', 'myCallback'])
})

test('extractManifest accepts a real zod schema for schema and state', () => {
  const schema = z.object({ dir: z.string() })
  const state = z.object({ count: z.number().default(0) })
  const m = extractManifest({ schema, state })
  assert.equal(m.schema, schema)
  assert.equal(m.state, state)
})

// ---------------------------------------------------------------------------
// buildInitialState edge cases
// ---------------------------------------------------------------------------

test('buildInitialState with null stateSchema includes all persisted keys', () => {
  const out = buildInitialState({
    stateSchema: null,
    persistedSnapshot: { x: 1 },
    validatedParams: { y: 2 },
  })
  // No schema → persisted keys are included (no schema to filter them against);
  // params are NOT overlaid because there's no schema to resolve state key names.
  assert.deepEqual(out, { x: 1 })
})

test('buildInitialState overlays persisted only for known state keys', () => {
  const stateSchema = z.object({ a: z.number().default(0).persist() })
  const out = buildInitialState({
    stateSchema,
    persistedSnapshot: { a: 99, unknown: 'ignored' },
    validatedParams: {},
  })
  assert.equal(out.a, 99)
  assert.ok(!('unknown' in out))
})

test('buildInitialState params win over persisted snapshot', () => {
  const stateSchema = z.object({
    dir: z.string().default('./src').persist(),
  })
  const out = buildInitialState({
    stateSchema,
    persistedSnapshot: { dir: './persisted' },
    validatedParams: { dir: './from-cli' },
  })
  assert.equal(out.dir, './from-cli')
})

test('buildInitialState params keys not in state schema are excluded', () => {
  const stateSchema = z.object({ count: z.number().default(0) })
  const out = buildInitialState({
    stateSchema,
    persistedSnapshot: null,
    validatedParams: { count: 5, extraParam: 'ignored' },
  })
  assert.equal(out.count, 5)
  assert.ok(!('extraParam' in out))
})

test('buildInitialState with schema parse error falls back to empty base', () => {
  // A schema with required fields and no defaults → parse({}) throws → fallback
  const stateSchema = z.object({ required: z.string() })
  // Should not throw; falls through with empty base.
  const out = buildInitialState({
    stateSchema,
    persistedSnapshot: null,
    validatedParams: {},
  })
  assert.deepEqual(out, {})
})

test('buildInitialState with null persistedSnapshot uses defaults only', () => {
  const stateSchema = z.object({ n: z.number().default(7).persist() })
  const out = buildInitialState({ stateSchema, persistedSnapshot: null, validatedParams: {} })
  assert.equal(out.n, 7)
})

test('buildInitialState: non-object persistedSnapshot is treated as empty', () => {
  const stateSchema = z.object({ n: z.number().default(0).persist() })
  const out = buildInitialState({
    stateSchema,
    persistedSnapshot: 'bad',
    validatedParams: {},
  })
  assert.equal(out.n, 0) // default only
})
