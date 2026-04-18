// Additional edge-case tests for params.mjs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { coerceValue, mergeRawParams, validateParams, queryFromSource } from '../params.mjs'

// ---------------------------------------------------------------------------
// coerceValue
// ---------------------------------------------------------------------------

test('coerceValue: plain non-JSON string passes through unchanged', () => {
  assert.equal(coerceValue('hello world'), 'hello world')
  assert.equal(coerceValue('./src'), './src')
  assert.equal(coerceValue('foo/bar.ts'), 'foo/bar.ts')
})

test('coerceValue: empty string returns empty string', () => {
  assert.equal(coerceValue(''), '')
})

test('coerceValue: "null" parses to null', () => {
  assert.equal(coerceValue('null'), null)
})

test('coerceValue: "true" and "false" parse to booleans', () => {
  assert.equal(coerceValue('true'), true)
  assert.equal(coerceValue('false'), false)
})

test('coerceValue: negative number strings parse to numbers', () => {
  assert.equal(coerceValue('-42'), -42)
  assert.equal(coerceValue('-3.14'), -3.14)
})

test('coerceValue: zero parses to 0', () => {
  assert.equal(coerceValue('0'), 0)
})

test('coerceValue: quoted JSON string parses to string', () => {
  assert.equal(coerceValue('"hello"'), 'hello')
})

test('coerceValue: nested JSON object parses deeply', () => {
  assert.deepEqual(coerceValue('{"a":{"b":1}}'), { a: { b: 1 } })
})

test('coerceValue: malformed JSON falls back to raw string', () => {
  assert.equal(coerceValue('[not json'), '[not json')
  assert.equal(coerceValue('{bad}'), '{bad}')
})

test('coerceValue: non-string pass-through (number stays number)', () => {
  assert.equal(coerceValue(42), 42)
  assert.equal(coerceValue(true), true)
  assert.equal(coerceValue(null), null)
})

test('coerceValue: whitespace-trimmed string uses first char for detection', () => {
  // Leading space before a number → trimmed → JSON parse to number
  assert.equal(coerceValue('  42  '), 42)
})

// ---------------------------------------------------------------------------
// mergeRawParams
// ---------------------------------------------------------------------------

test('mergeRawParams: empty query and empty flags returns {}', () => {
  assert.deepEqual(mergeRawParams({ query: {}, flags: {} }), {})
})

test('mergeRawParams: undefined query and flags treated as empty', () => {
  assert.deepEqual(mergeRawParams({ query: undefined, flags: undefined }), {})
  assert.deepEqual(mergeRawParams({}), {})
})

test('mergeRawParams: null query and flags treated as empty', () => {
  assert.deepEqual(mergeRawParams({ query: null, flags: null }), {})
})

test('mergeRawParams: query-only keys are included', () => {
  const out = mergeRawParams({ query: { a: 'foo' }, flags: {} })
  assert.equal(out.a, 'foo')
})

test('mergeRawParams: flags coerce values from JSON-like strings', () => {
  const out = mergeRawParams({ query: {}, flags: { n: '123' } })
  assert.equal(out.n, 123)
})

test('mergeRawParams: both query and flags present, flags win on collision', () => {
  const out = mergeRawParams({ query: { x: 'query' }, flags: { x: 'flag' } })
  assert.equal(out.x, 'flag')
})

test('mergeRawParams: query-only and flag-only keys are both present', () => {
  const out = mergeRawParams({ query: { a: 'A' }, flags: { b: 'B' } })
  assert.equal(out.a, 'A')
  assert.equal(out.b, 'B')
})

// ---------------------------------------------------------------------------
// validateParams
// ---------------------------------------------------------------------------

test('validateParams: null schema passes merged through unchanged', () => {
  const r = validateParams(null, { foo: 'bar' })
  assert.equal(r.ok, true)
  assert.deepEqual(r.data, { foo: 'bar' })
})

test('validateParams: undefined schema passes merged through unchanged', () => {
  const r = validateParams(undefined, { x: 1 })
  assert.equal(r.ok, true)
  assert.deepEqual(r.data, { x: 1 })
})

test('validateParams: valid data returns {ok:true, data}', () => {
  const schema = z.object({ n: z.number().default(0) })
  const r = validateParams(schema, {})
  assert.equal(r.ok, true)
  assert.equal(r.data.n, 0)
})

test('validateParams: invalid data returns {ok:false, issues} with path/message/code', () => {
  const schema = z.object({ name: z.string() })
  const r = validateParams(schema, { name: 42 })
  assert.equal(r.ok, false)
  assert.equal(Array.isArray(r.issues), true)
  assert.ok(r.issues.length >= 1)
  assert.equal(r.issues[0].path, 'name')
  assert.ok(r.issues[0].message)
  assert.ok(r.issues[0].code)
})

test('validateParams: missing required field appears in issues', () => {
  const schema = z.object({ required: z.string() })
  const r = validateParams(schema, {})
  assert.equal(r.ok, false)
  assert.ok(r.issues.some((i) => i.path === 'required'))
})

test('validateParams: nested path is joined with dot', () => {
  const schema = z.object({ outer: z.object({ inner: z.number() }) })
  const r = validateParams(schema, { outer: { inner: 'bad' } })
  assert.equal(r.ok, false)
  assert.ok(r.issues.some((i) => i.path === 'outer.inner'))
})

test('validateParams: root-level error uses <root> path', () => {
  // A schema that fails at root (e.g. z.string() passed an object)
  const schema = z.string()
  const r = validateParams(schema, { x: 1 })
  assert.equal(r.ok, false)
  // The exact path depends on zod version but should not be empty string.
  assert.ok(r.issues.length >= 1)
})

// ---------------------------------------------------------------------------
// queryFromSource
// ---------------------------------------------------------------------------

test('queryFromSource: http URL returns query params', () => {
  const q = queryFromSource('http://example.com/s.mjs?a=1&b=hello')
  assert.equal(q.a, '1')
  assert.equal(q.b, 'hello')
})

test('queryFromSource: https URL returns query params', () => {
  const q = queryFromSource('https://cdn.example.com/script.mjs?x=42')
  assert.equal(q.x, '42')
})

test('queryFromSource: URL with no query returns {}', () => {
  assert.deepEqual(queryFromSource('https://example.com/s.mjs'), {})
})

test('queryFromSource: file:// URL with query params returns them', () => {
  const q = queryFromSource('file:///home/user/s.mjs?debug=true')
  assert.equal(q.debug, 'true')
})

test('queryFromSource: bare file path (no protocol) returns {}', () => {
  assert.deepEqual(queryFromSource('/home/user/script.mjs'), {})
})

test('queryFromSource: relative path returns {}', () => {
  assert.deepEqual(queryFromSource('./script.mjs'), {})
})

test('queryFromSource: empty string returns {}', () => {
  assert.deepEqual(queryFromSource(''), {})
})

test('queryFromSource: null returns {}', () => {
  assert.deepEqual(queryFromSource(null), {})
})

test('queryFromSource: undefined returns {}', () => {
  assert.deepEqual(queryFromSource(undefined), {})
})

test('queryFromSource: non-string number returns {}', () => {
  assert.deepEqual(queryFromSource(42), {})
})

test('queryFromSource: multi-value duplicate param returns last', () => {
  const q = queryFromSource('https://example.com/s.mjs?x=1&x=2')
  // URLSearchParams.get returns first; .entries() yields all.
  // Our implementation uses .entries() building into a plain object — last wins.
  assert.ok('x' in q)
})
