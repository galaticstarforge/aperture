// Additional edge-case tests for schema-markers.mjs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import {
  install,
  isPersist,
  isStream,
  collectFlaggedKeys,
  isZodSchema,
  PERSIST,
  STREAM,
} from '../schema-markers.mjs'

install()

// ---------------------------------------------------------------------------
// install() idempotency
// ---------------------------------------------------------------------------

test('install() is safe to call multiple times', () => {
  install()
  install()
  // verify markers still work after repeated installs
  const s = z.string().persist()
  assert.equal(isPersist(s), true)
})

// ---------------------------------------------------------------------------
// isPersist — wrapper chains
// ---------------------------------------------------------------------------

test('isPersist: bare string without marker is false', () => {
  assert.equal(isPersist(z.string()), false)
})

test('isPersist: survives .nullable() wrapping', () => {
  const s = z.string().persist().nullable()
  assert.equal(isPersist(s), true)
})

test('isPersist: survives .nullable().default() chaining', () => {
  const s = z.string().persist().nullable().default(null)
  assert.equal(isPersist(s), true)
})

test('isPersist: survives .optional().default() chaining', () => {
  const s = z.string().persist().optional().default(undefined)
  assert.equal(isPersist(s), true)
})

test('isPersist: number, boolean, any types all accept the marker', () => {
  assert.equal(isPersist(z.number().persist()), true)
  assert.equal(isPersist(z.boolean().persist()), true)
  assert.equal(isPersist(z.any().persist()), true)
})

test('isPersist: array schema with persist marker', () => {
  assert.equal(isPersist(z.array(z.string()).persist()), true)
})

test('isPersist: object schema with persist marker', () => {
  assert.equal(isPersist(z.object({ x: z.string() }).persist()), true)
})

// ---------------------------------------------------------------------------
// isStream — wrapper chains
// ---------------------------------------------------------------------------

test('isStream: bare schema without stream is false', () => {
  assert.equal(isStream(z.any()), false)
})

test('isStream: .stream() on any() returns true', () => {
  assert.equal(isStream(z.any().stream()), true)
})

test('isStream: survives .default() wrapping', () => {
  const s = z.any().stream().default(null)
  assert.equal(isStream(s), true)
})

test('isStream: survives .optional() wrapping', () => {
  const s = z.any().stream().optional()
  assert.equal(isStream(s), true)
})

test('isStream: survives .nullable() wrapping', () => {
  const s = z.any().stream().nullable()
  assert.equal(isStream(s), true)
})

// ---------------------------------------------------------------------------
// Both markers coexist
// ---------------------------------------------------------------------------

test('a schema can be both persist and stream', () => {
  const s = z.any().persist().stream()
  assert.equal(isPersist(s), true)
  assert.equal(isStream(s), true)
})

test('persist and stream in opposite order both set', () => {
  const s = z.any().stream().persist()
  assert.equal(isPersist(s), true)
  assert.equal(isStream(s), true)
})

// ---------------------------------------------------------------------------
// collectFlaggedKeys
// ---------------------------------------------------------------------------

test('collectFlaggedKeys returns empty sets for empty object schema', () => {
  const { persistKeys, streamKeys } = collectFlaggedKeys(z.object({}))
  assert.equal(persistKeys.size, 0)
  assert.equal(streamKeys.size, 0)
})

test('collectFlaggedKeys returns empty sets for null input', () => {
  const { persistKeys, streamKeys } = collectFlaggedKeys(null)
  assert.equal(persistKeys.size, 0)
  assert.equal(streamKeys.size, 0)
})

test('collectFlaggedKeys returns empty sets for non-object input', () => {
  const { persistKeys, streamKeys } = collectFlaggedKeys('not a schema')
  assert.equal(persistKeys.size, 0)
  assert.equal(streamKeys.size, 0)
})

test('collectFlaggedKeys: key with both markers appears in both sets', () => {
  const schema = z.object({ x: z.any().persist().stream() })
  const { persistKeys, streamKeys } = collectFlaggedKeys(schema)
  assert.ok(persistKeys.has('x'))
  assert.ok(streamKeys.has('x'))
})

test('collectFlaggedKeys: unmarked key in neither set', () => {
  const schema = z.object({ plain: z.string() })
  const { persistKeys, streamKeys } = collectFlaggedKeys(schema)
  assert.ok(!persistKeys.has('plain'))
  assert.ok(!streamKeys.has('plain'))
})

test('collectFlaggedKeys: multiple persist keys collected correctly', () => {
  const schema = z.object({
    a: z.string().persist(),
    b: z.number().persist(),
    c: z.string(), // not persist
  })
  const { persistKeys } = collectFlaggedKeys(schema)
  assert.deepEqual([...persistKeys].sort(), ['a', 'b'])
})

test('collectFlaggedKeys: multiple stream keys collected correctly', () => {
  const schema = z.object({
    report: z.any().stream(),
    other: z.any().stream(),
    plain: z.any(),
  })
  const { streamKeys } = collectFlaggedKeys(schema)
  assert.deepEqual([...streamKeys].sort(), ['other', 'report'])
})

// ---------------------------------------------------------------------------
// isZodSchema
// ---------------------------------------------------------------------------

test('isZodSchema: real zod schemas return true', () => {
  assert.equal(isZodSchema(z.string()), true)
  assert.equal(isZodSchema(z.number()), true)
  assert.equal(isZodSchema(z.object({})), true)
  assert.equal(isZodSchema(z.array(z.string())), true)
  assert.equal(isZodSchema(z.any()), true)
})

test('isZodSchema: plain objects without _def return false', () => {
  assert.equal(isZodSchema({}), false)
  assert.equal(isZodSchema({ type: 'string' }), false)
})

test('isZodSchema: null returns false', () => {
  assert.equal(isZodSchema(null), false)
})

test('isZodSchema: undefined returns false', () => {
  assert.equal(isZodSchema(undefined), false)
})

test('isZodSchema: string returns false', () => {
  assert.equal(isZodSchema('z.string()'), false)
})

test('isZodSchema: number returns false', () => {
  assert.equal(isZodSchema(42), false)
})

test('isZodSchema: function returns false', () => {
  assert.equal(isZodSchema(() => {}), false)
})

test('isZodSchema: duck-typed object with _def object returns true', () => {
  // A foreign zod instance (different module URL) would pass this duck check.
  assert.equal(isZodSchema({ _def: {} }), true)
})

test('isZodSchema: object with _def=null returns false', () => {
  // _def must be a non-null object.
  assert.equal(isZodSchema({ _def: null }), false)
})

// ---------------------------------------------------------------------------
// PERSIST / STREAM symbols
// ---------------------------------------------------------------------------

test('PERSIST symbol is globally registered (Symbol.for)', () => {
  assert.equal(PERSIST, Symbol.for('aperture.persist'))
})

test('STREAM symbol is globally registered (Symbol.for)', () => {
  assert.equal(STREAM, Symbol.for('aperture.stream'))
})

test('marker symbol is stamped directly on the schema instance', () => {
  const s = z.string().persist()
  assert.equal(s[PERSIST], true)
})

test('marker survives wrapping: outer wrapper does NOT carry the symbol', () => {
  const s = z.string().persist()
  const wrapped = s.optional()
  // The PERSIST symbol is on the inner schema, not necessarily on the wrapper.
  // isPersist walks inner, so this is fine — just documenting the walk.
  assert.equal(isPersist(wrapped), true)
})
