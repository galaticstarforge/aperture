// Reactive state store — the phase 2 backbone.
//
// Exposed through `runtime.state`: `set`, `get`, `setIn`, `push`, `watch`,
// `persist`. Every write fires watchers and emits a wire event; GUI-origin
// writes are applied through the same codepath so watchers fire symmetrically
// regardless of origin (design.md §"Watch Semantics").
//
// Internals:
//   - `values`                — flat Map<key, value> of the current state
//   - `watchers`              — Map<key, Set<handler>>
//   - `chains`                — Map<key, Promise> to serialize same-key
//                               async handlers
//   - `lastOriginInTick`      — Map<key, 'gui' | 'script'>, cleared at
//                               microtask boundary, used for the same-tick
//                               write-conflict rule
//   - `userEditableBoundKeys` — Set<key>; populated by Phase 3's renderer
//                               when it binds a key to an editable element
//
// Write-conflict rule (design.md §"State Write Conflicts"):
//   When both origins touch the same key within a microtask tick:
//     - GUI wins if the key is currently bound to input/number/slider/select/
//       checkbox/textarea/file;
//     - Script wins otherwise.
//   The losing write is dropped (no broadcast, no watcher fire), and the
//   value + origin of the loser are logged at debug for diagnosability.
//
// Streaming (design.md §"Streaming Opt-In"):
//   Writes to a streamKey are chunked into `state:set:chunk` events of at
//   most `CHUNK_BYTES` UTF-16 code units. The final chunk carries
//   `final: true`. Reassembly happens on the Tauri backend.

import { collectFlaggedKeys } from './schema-markers.mjs'

const CHUNK_BYTES = 64 * 1024

export class StateStore {
  constructor({ stateSchema, initialValues, emit, log, stateFilePath }) {
    this.stateSchema = stateSchema
    this.values = new Map(Object.entries(initialValues ?? {}))
    this.watchers = new Map()
    this.chains = new Map()
    this.lastOriginInTick = new Map()
    this.tickScheduled = false
    this.userEditableBoundKeys = new Set()
    this.emit = emit
    this.log = log ?? (() => {})
    this.stateFilePath = stateFilePath ?? null

    const { persistKeys, streamKeys } = collectFlaggedKeys(stateSchema)
    this.persistKeys = persistKeys
    this.streamKeys = streamKeys
  }

  /**
   * Called by Phase 3 renderer when it binds a state key to a user-editable
   * element. Phase 2 leaves this Set empty, which makes the same-tick write
   * conflict fall back to `script wins` (the documented default).
   */
  markBoundEditable(key) {
    this.userEditableBoundKeys.add(key)
  }
  unmarkBoundEditable(key) {
    this.userEditableBoundKeys.delete(key)
  }

  get(key) {
    return this.values.get(key)
  }

  set(key, value, origin = 'script') {
    if (this.#resolveConflict(key, origin)) {
      // The prior write this tick wins — drop this one.
      return false
    }
    this.values.set(key, value)
    this.#broadcast(key, value, origin)
    this.#fireWatchers(key, value)
    return true
  }

  setIn(path, value) {
    if (!Array.isArray(path) || path.length === 0) {
      throw new TypeError('state.setIn(path, value) — path must be a non-empty array')
    }
    const [rootKey, ...rest] = path
    const root = this.values.get(rootKey)
    const next = structuralSet(root, rest, value)
    return this.set(rootKey, next, 'script')
  }

  push(key, item) {
    const cur = this.values.get(key)
    const arr = Array.isArray(cur) ? cur.slice() : []
    arr.push(item)
    return this.set(key, arr, 'script')
  }

  watch(key, handler) {
    if (typeof handler !== 'function') {
      throw new TypeError('state.watch(key, handler) — handler must be a function')
    }
    let set = this.watchers.get(key)
    if (!set) {
      set = new Set()
      this.watchers.set(key, set)
    }
    set.add(handler)
    return () => {
      const s = this.watchers.get(key)
      if (s) {
        s.delete(handler)
        if (s.size === 0) this.watchers.delete(key)
      }
    }
  }

  async persist() {
    if (!this.stateFilePath) {
      // No cache key derivable (script has no `// @aperture-version`). Design:
      // "Scripts without the version comment are never cached."
      this.log('persist skipped — no cache key available', 'debug')
      return false
    }
    const snapshot = {}
    for (const k of this.persistKeys) {
      if (this.values.has(k)) snapshot[k] = this.values.get(k)
    }
    const { writeFile, rename, mkdir } = await import('node:fs/promises')
    const { dirname } = await import('node:path')
    await mkdir(dirname(this.stateFilePath), { recursive: true })
    const tmp = this.stateFilePath + '.tmp'
    await writeFile(tmp, JSON.stringify(snapshot, null, 2), 'utf8')
    await rename(tmp, this.stateFilePath)
    return true
  }

  // --- internals ------------------------------------------------------------

  #resolveConflict(key, origin) {
    const prior = this.lastOriginInTick.get(key)
    if (!prior) {
      this.lastOriginInTick.set(key, origin)
      this.#scheduleTickClear()
      return false
    }
    if (prior === origin) {
      // Same origin writing twice in the same tick — order-of-operations
      // applies; both writes proceed.
      return false
    }
    // Different origins touched the same key in the same tick.
    const guiWins = this.userEditableBoundKeys.has(key)
    if (guiWins ? origin !== 'gui' : origin !== 'script') {
      this.log(`state-conflict: ${origin} lost for key=${key} (gui-wins=${guiWins})`, 'debug')
      return true
    }
    // New origin wins; update the stamp so subsequent same-tick writes see it.
    this.lastOriginInTick.set(key, origin)
    return false
  }

  #scheduleTickClear() {
    if (this.tickScheduled) return
    this.tickScheduled = true
    queueMicrotask(() => {
      this.lastOriginInTick.clear()
      this.tickScheduled = false
    })
  }

  #broadcast(key, value, origin) {
    if (origin === 'gui') {
      // GUI is already authoritative on its own side — no need to echo back.
      return
    }
    if (this.streamKeys.has(key)) {
      const json = safeStringify(value)
      if (json.length <= CHUNK_BYTES) {
        this.emit({ type: 'state:set:chunk', key, chunk: json, final: true })
        return
      }
      for (let i = 0; i < json.length; i += CHUNK_BYTES) {
        const chunk = json.slice(i, i + CHUNK_BYTES)
        const final = i + CHUNK_BYTES >= json.length
        this.emit({ type: 'state:set:chunk', key, chunk, final })
      }
      return
    }
    this.emit({ type: 'state:set', key, value })
  }

  #fireWatchers(key, value) {
    const set = this.watchers.get(key)
    if (!set || set.size === 0) return
    // Same-key handlers run serially via a per-key chain. Cross-key
    // handlers run independently because each chain is keyed on `key`.
    const prior = this.chains.get(key) ?? Promise.resolve()
    const next = prior
      .catch(() => {}) // isolate watcher failures between iterations
      .then(async () => {
        for (const handler of set) {
          try {
            await handler(value)
          } catch (err) {
            this.log(
              `watch(${key}) handler threw: ${err?.message ?? err}`,
              'error',
              err?.stack,
            )
          }
        }
      })
    this.chains.set(key, next)
  }
}

function structuralSet(root, rest, value) {
  if (rest.length === 0) return value
  if (Array.isArray(root)) {
    const copy = root.slice()
    const idx = typeof rest[0] === 'number' ? rest[0] : Number(rest[0])
    copy[idx] = structuralSet(copy[idx], rest.slice(1), value)
    return copy
  }
  const base = root && typeof root === 'object' ? { ...root } : {}
  base[rest[0]] = structuralSet(base[rest[0]], rest.slice(1), value)
  return base
}

function safeStringify(value) {
  try {
    return JSON.stringify(value)
  } catch {
    // Circular or BigInt; best effort.
    return JSON.stringify(String(value))
  }
}
