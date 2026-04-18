import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import {
  install,
  isPersist,
  isStream,
  collectFlaggedKeys,
  isZodSchema,
} from '../schema-markers.mjs'

install()

test('persist marker survives default() chaining in either order', () => {
  const a = z.number().persist().default(50)
  const b = z.number().default(50).persist()
  assert.equal(isPersist(a), true)
  assert.equal(isPersist(b), true)
})

test('persist marker survives optional() wrapping', () => {
  const s = z.string().persist().optional()
  assert.equal(isPersist(s), true)
})

test('stream marker is detectable', () => {
  const s = z.any().stream()
  assert.equal(isStream(s), true)
  assert.equal(isPersist(s), false)
})

test('collectFlaggedKeys picks out both sets from an object schema', () => {
  const schema = z.object({
    threshold: z.number().default(50).persist(),
    targetDir: z.string().persist(),
    events: z.array(z.any()),
    bigReport: z.any().stream(),
    both: z.string().persist().stream(),
  })
  const { persistKeys, streamKeys } = collectFlaggedKeys(schema)
  assert.deepEqual([...persistKeys].sort(), ['both', 'targetDir', 'threshold'])
  assert.deepEqual([...streamKeys].sort(), ['bigReport', 'both'])
})

test('isZodSchema duck-types on _def', () => {
  assert.equal(isZodSchema(z.string()), true)
  assert.equal(isZodSchema({}), false)
  assert.equal(isZodSchema(null), false)
  assert.equal(isZodSchema({ _def: {} }), true) // duck-type
})
