import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import {
  coerceValue,
  mergeRawParams,
  validateParams,
  queryFromSource,
} from '../params.mjs'

test('coerceValue parses JSON-shaped strings, keeps plain strings', () => {
  assert.equal(coerceValue('./src'), './src')
  assert.equal(coerceValue('true'), true)
  assert.equal(coerceValue('42'), 42)
  assert.deepEqual(coerceValue('["*.js"]'), ['*.js'])
  assert.deepEqual(coerceValue('{"a":1}'), { a: 1 })
  // Malformed JSON falls back to the raw string rather than throwing.
  assert.equal(coerceValue('[not json'), '[not json')
})

test('CLI flags win on collision with URL query', () => {
  const merged = mergeRawParams({
    query: { targetDir: './foo' },
    flags: { targetDir: './bar' },
  })
  assert.equal(merged.targetDir, './bar')
})

test('Complex CLI values parse to arrays', () => {
  const merged = mergeRawParams({ query: {}, flags: { filters: '["*.js"]' } })
  assert.deepEqual(merged.filters, ['*.js'])
})

test('validateParams surfaces zod issues structurally', () => {
  const schema = z.object({ targetDir: z.string() })
  const bad = validateParams(schema, { targetDir: 42 })
  assert.equal(bad.ok, false)
  assert.equal(bad.issues.length >= 1, true)
  assert.equal(bad.issues[0].path, 'targetDir')
})

test('validateParams returns frozen-shape success data', () => {
  const schema = z.object({ targetDir: z.string().default('./src') })
  const good = validateParams(schema, {})
  assert.equal(good.ok, true)
  assert.equal(good.data.targetDir, './src')
})

test('queryFromSource pulls query params from http URLs', () => {
  const q = queryFromSource('https://example.com/s.mjs?targetDir=./foo&dryRun=true')
  assert.equal(q.targetDir, './foo')
  assert.equal(q.dryRun, 'true')
})

test('queryFromSource returns empty for bare paths', () => {
  assert.deepEqual(queryFromSource('/abs/path.mjs'), {})
  assert.deepEqual(queryFromSource(''), {})
})
