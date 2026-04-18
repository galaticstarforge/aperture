// Additional edge-case tests for StateStore beyond the happy-path suite.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { install } from '../schema-markers.mjs'
import { StateStore } from '../state-store.mjs'

install()

function makeStore(overrides = {}) {
  const emitted = []
  const logged = []
  const schema =
    overrides.schema ??
    z.object({
      count: z.number().default(0),
      label: z.string().default('').persist(),
      items: z.array(z.any()).default([]),
      big: z.any().default(null).stream(),
    })
  const store = new StateStore({
    stateSchema: schema,
    initialValues: overrides.initialValues ?? schema.parse({}),
    emit: (ev) => emitted.push(ev),
    log: (...args) => logged.push(args),
    stateFilePath: overrides.stateFilePath ?? null,
  })
  return { store, emitted, logged }
}

// ---------------------------------------------------------------------------
// setIn edge cases
// ---------------------------------------------------------------------------

test('setIn throws TypeError when path is empty array', () => {
  const { store } = makeStore()
  assert.throws(() => store.setIn([], 'val'), TypeError)
})

test('setIn throws TypeError when path is not an array', () => {
  const { store } = makeStore()
  assert.throws(() => store.setIn('count', 1), TypeError)
})

test('setIn creates object when root is undefined', () => {
  const { store } = makeStore()
  store.setIn(['newKey', 'nested'], 42)
  assert.deepEqual(store.get('newKey'), { nested: 42 })
})

test('setIn handles numeric string index in array path', () => {
  const { store } = makeStore()
  store.set('items', [{ v: 0 }, { v: 1 }])
  store.setIn(['items', '1', 'v'], 99)
  assert.equal(store.get('items')[1].v, 99)
})

test('setIn clones arrays at each level (no mutation of prior value)', () => {
  const { store } = makeStore()
  const original = [{ x: 0 }]
  store.set('items', original)
  store.setIn(['items', 0, 'x'], 1)
  assert.equal(original[0].x, 0) // original unchanged
})

test('setIn on deeply nested object creates intermediate nodes', () => {
  const { store } = makeStore()
  store.setIn(['newRoot', 'a', 'b', 'c'], 'deep')
  assert.deepEqual(store.get('newRoot'), { a: { b: { c: 'deep' } } })
})

// ---------------------------------------------------------------------------
// push edge cases
// ---------------------------------------------------------------------------

test('push on undefined root creates array with the item', () => {
  const { store } = makeStore()
  store.push('nonexistent', 'first')
  assert.deepEqual(store.get('nonexistent'), ['first'])
})

test('push on non-array value discards old value and starts fresh', () => {
  const { store } = makeStore()
  store.set('count', 999) // count is a number, not array
  store.push('count', 'a')
  assert.deepEqual(store.get('count'), ['a'])
})

test('push does not mutate the stored array', () => {
  const { store } = makeStore()
  store.set('items', ['x'])
  const before = store.get('items')
  store.push('items', 'y')
  assert.equal(before.length, 1) // original reference not mutated
})

// ---------------------------------------------------------------------------
// watch edge cases
// ---------------------------------------------------------------------------

test('watch throws TypeError when handler is not a function', () => {
  const { store } = makeStore()
  assert.throws(() => store.watch('count', 'not-a-function'), TypeError)
})

test('watch with null handler throws TypeError', () => {
  const { store } = makeStore()
  assert.throws(() => store.watch('count', null), TypeError)
})

test('multiple watchers on the same key all fire', async () => {
  const { store } = makeStore()
  const a = [], b = []
  store.watch('count', (v) => a.push(v))
  store.watch('count', (v) => b.push(v))
  store.set('count', 5)
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(a, [5])
  assert.deepEqual(b, [5])
})

test('watcher on key A does not fire when key B is set', async () => {
  const { store } = makeStore()
  const seen = []
  store.watch('count', (v) => seen.push(v))
  store.set('label', 'hello')
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(seen, [])
})

test('watcher throwing is isolated — other watchers still run', async () => {
  const { store, logged } = makeStore()
  const good = []
  store.watch('count', () => { throw new Error('bad watcher') })
  store.watch('count', (v) => good.push(v))
  store.set('count', 3)
  await new Promise((r) => setTimeout(r, 20))
  // The good watcher should still fire (it runs in the same .then chain,
  // after the bad one, but the chain continues).
  assert.deepEqual(good, [3])
})

test('unmarkBoundEditable removes key from editable set', () => {
  const { store } = makeStore()
  store.markBoundEditable('count')
  assert.ok(store.userEditableBoundKeys.has('count'))
  store.unmarkBoundEditable('count')
  assert.ok(!store.userEditableBoundKeys.has('count'))
})

// ---------------------------------------------------------------------------
// broadcast / stream edge cases
// ---------------------------------------------------------------------------

test('GUI-origin write does not emit a state:set event (no echo back)', () => {
  const { store, emitted } = makeStore()
  const before = emitted.length
  store.set('count', 42, 'gui')
  // The value is stored but nothing is broadcast back.
  assert.equal(store.get('count'), 42)
  assert.equal(emitted.length, before)
})

test('stream key with value ≤ CHUNK_BYTES emits a single final chunk', () => {
  const { store, emitted } = makeStore()
  emitted.length = 0
  store.set('big', 'tiny')
  const chunks = emitted.filter((e) => e.type === 'state:set:chunk')
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].final, true)
  assert.equal(JSON.parse(chunks[0].chunk), 'tiny')
})

test('non-stream key with large value emits a plain state:set event', () => {
  const { store, emitted } = makeStore()
  const big = 'x'.repeat(100 * 1024)
  emitted.length = 0
  store.set('label', big) // label is persist but NOT stream
  const ev = emitted.at(-1)
  assert.equal(ev.type, 'state:set')
  assert.equal(ev.key, 'label')
})

test('stream key JSON is split exactly at CHUNK_BYTES boundaries', () => {
  const { store, emitted } = makeStore()
  const CHUNK = 64 * 1024
  // Create a value whose JSON is exactly 2× CHUNK_BYTES.
  const target = CHUNK * 2
  // JSON.stringify(str) is len+2 (quotes). Pad to target-2 chars.
  const str = 'a'.repeat(target - 2)
  emitted.length = 0
  store.set('big', str)
  const chunks = emitted.filter((e) => e.type === 'state:set:chunk')
  assert.ok(chunks.length >= 2)
  const reassembled = JSON.parse(chunks.map((c) => c.chunk).join(''))
  assert.equal(reassembled, str)
})

// ---------------------------------------------------------------------------
// persist edge cases
// ---------------------------------------------------------------------------

test('persist returns false when stateFilePath is null', async () => {
  const { store } = makeStore({ stateFilePath: null })
  const result = await store.persist()
  assert.equal(result, false)
})

test('persist creates parent directory if it does not exist', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const base = await mkdtemp(join(tmpdir(), 'aperture-persist-mk-'))
  const stateFilePath = join(base, 'nested', 'deep', 'state.json')
  try {
    const schema = z.object({ k: z.string().default('v').persist() })
    const store = new StateStore({
      stateSchema: schema,
      initialValues: schema.parse({}),
      emit: () => {},
      log: () => {},
      stateFilePath,
    })
    const ok = await store.persist()
    assert.equal(ok, true)
    const { readFile } = await import('node:fs/promises')
    const raw = JSON.parse(await readFile(stateFilePath, 'utf8'))
    assert.equal(raw.k, 'v')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('persist uses atomic tmp→rename (no partial writes)', async () => {
  const { mkdtemp, rm, stat } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const base = await mkdtemp(join(tmpdir(), 'aperture-atomic-'))
  const stateFilePath = join(base, 'state.json')
  try {
    const schema = z.object({ x: z.number().default(1).persist() })
    const store = new StateStore({
      stateSchema: schema,
      initialValues: schema.parse({}),
      emit: () => {},
      log: () => {},
      stateFilePath,
    })
    await store.persist()
    // tmp file should not exist after successful persist.
    await assert.rejects(stat(stateFilePath + '.tmp'))
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('persist only writes persistKeys, not all keys', async () => {
  const { mkdtemp, rm, readFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const base = await mkdtemp(join(tmpdir(), 'aperture-persist-sel-'))
  const stateFilePath = join(base, 'state.json')
  try {
    const schema = z.object({
      saved: z.string().default('yes').persist(),
      transient: z.string().default('no'),
    })
    const { store } = makeStore({ schema, stateFilePath })
    store.set('saved', 'A')
    store.set('transient', 'B')
    await store.persist()
    const raw = JSON.parse(await readFile(stateFilePath, 'utf8'))
    assert.ok('saved' in raw)
    assert.ok(!('transient' in raw))
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// same-tick conflict: multiple writes from same origin both proceed
// ---------------------------------------------------------------------------

test('two script writes in same tick — both proceed in order', () => {
  const { store } = makeStore()
  store.set('count', 1, 'script')
  store.set('count', 2, 'script')
  assert.equal(store.get('count'), 2)
})

test('two GUI writes in same tick — both proceed in order', () => {
  const { store } = makeStore()
  store.set('count', 10, 'gui')
  store.set('count', 20, 'gui')
  assert.equal(store.get('count'), 20)
})
