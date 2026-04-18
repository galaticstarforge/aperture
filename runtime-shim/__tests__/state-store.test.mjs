import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { install } from '../schema-markers.mjs'
import { StateStore } from '../state-store.mjs'

install()

function makeStore(extra = {}) {
  const emitted = []
  const schema =
    extra.schema ??
    z.object({
      counter: z.number().default(0),
      targetDir: z.string().default('./src').persist(),
      threshold: z.number().default(50).persist(),
      events: z.array(z.any()).default([]),
      bigReport: z.any().default(null).stream(),
    })
  const store = new StateStore({
    stateSchema: schema,
    initialValues: schema.parse({}),
    emit: (ev) => emitted.push(ev),
    log: () => {},
    stateFilePath: extra.stateFilePath ?? null,
  })
  return { store, emitted, schema }
}

test('set/get round-trips and emits state:set', () => {
  const { store, emitted } = makeStore()
  store.set('counter', 7)
  assert.equal(store.get('counter'), 7)
  const lastEmit = emitted.at(-1)
  assert.deepEqual(lastEmit, { type: 'state:set', key: 'counter', value: 7 })
})

test('watch fires on script-origin writes; returned fn unsubscribes', async () => {
  const { store } = makeStore()
  let seen = []
  const off = store.watch('counter', (v) => seen.push(v))
  store.set('counter', 1)
  store.set('counter', 2)
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(seen, [1, 2])
  off()
  store.set('counter', 3)
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(seen, [1, 2])
})

test('watch fires symmetrically on gui-origin writes', async () => {
  const { store } = makeStore()
  let seen = []
  store.watch('counter', (v) => seen.push(v))
  store.set('counter', 5, 'gui')
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(seen, [5])
})

test('same-key async handlers serialize; cross-key run in parallel', async () => {
  const { store } = makeStore()
  const order = []
  store.watch('counter', async (v) => {
    await new Promise((r) => setTimeout(r, 20))
    order.push(`a:${v}`)
  })
  store.watch('threshold', async (v) => {
    await new Promise((r) => setTimeout(r, 5))
    order.push(`b:${v}`)
  })
  store.set('counter', 1)
  store.set('counter', 2)
  store.set('threshold', 9)
  await new Promise((r) => setTimeout(r, 100))
  // threshold handler (5ms) finishes before counter's (20ms each).
  assert.deepEqual(order, ['b:9', 'a:1', 'a:2'])
})

test('setIn clones intermediate nodes and broadcasts root key', () => {
  const { store, emitted } = makeStore()
  store.set('events', [{ id: 'a', status: 'pending' }])
  emitted.length = 0
  store.setIn(['events', 0, 'status'], 'done')
  assert.equal(store.get('events')[0].status, 'done')
  assert.equal(emitted.at(-1).type, 'state:set')
  assert.equal(emitted.at(-1).key, 'events')
})

test('push appends to array via setIn semantics', () => {
  const { store } = makeStore()
  store.push('events', { id: 'x' })
  store.push('events', { id: 'y' })
  assert.deepEqual(store.get('events').map((e) => e.id), ['x', 'y'])
})

test('stream-flagged key emits chunk events with final sentinel', () => {
  const { store, emitted } = makeStore()
  emitted.length = 0
  const big = 'a'.repeat(100 * 1024) // 100KB of a
  store.set('bigReport', big)
  const chunks = emitted.filter((e) => e.type === 'state:set:chunk')
  assert.ok(chunks.length >= 2, `expected ≥2 chunks, got ${chunks.length}`)
  assert.equal(chunks.at(-1).final, true)
  // Reassembly should yield the original value.
  const reassembled = JSON.parse(chunks.map((c) => c.chunk).join(''))
  assert.equal(reassembled, big)
})

test('persist writes persistKeys and restart reloads them', async () => {
  const { mkdtemp, rm, readFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'aperture-persist-'))
  const file = join(dir, 'test-state.json')
  try {
    const { store } = makeStore({ stateFilePath: file })
    store.set('threshold', 99) // persistKey
    store.set('counter', 3) // not a persistKey
    const ok = await store.persist()
    assert.equal(ok, true)
    const raw = JSON.parse(await readFile(file, 'utf8'))
    assert.deepEqual(Object.keys(raw).sort(), ['targetDir', 'threshold'])
    assert.equal(raw.threshold, 99)
    assert.ok(!('counter' in raw))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('same-tick write conflict: script wins when key is NOT editable', async () => {
  const { store } = makeStore()
  store.set('counter', 1, 'gui')
  store.set('counter', 2, 'script') // different origin, same tick
  // Phase 2 default: key not marked editable → script wins.
  assert.equal(store.get('counter'), 2)
})

test('same-tick write conflict: GUI wins when key IS marked editable', async () => {
  const { store } = makeStore()
  store.markBoundEditable('counter')
  store.set('counter', 1, 'gui')
  store.set('counter', 2, 'script') // should lose
  assert.equal(store.get('counter'), 1)
})
