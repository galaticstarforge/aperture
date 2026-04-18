// Zod schema markers — `.persist()` and `.stream()`.
//
// Design choice: we extend `ZodType.prototype` with two methods that stamp a
// symbol-keyed marker directly on the schema instance. Lookup walks inner
// types (`innerType`, `schema`) so markers survive `.default()` / `.optional()`
// / `.nullable()` chaining regardless of order — the user can write
// `z.string().persist().default('x')` or `z.string().default('x').persist()`.
//
// We deliberately do NOT use a separate WeakMap sidecar: a user may import
// zod from a different resolved path (e.g. via a future dep-install layout),
// and we want `.persist()` to still be callable regardless. Patching the
// prototype once, on the zod instance the shim saw first, covers the common
// case; importing zod through the shared NODE_PATH (see child.rs) ensures
// everyone gets the same module instance.

import { ZodType } from 'zod'

export const PERSIST = Symbol.for('aperture.persist')
export const STREAM = Symbol.for('aperture.stream')

let installed = false

export function install() {
  if (installed) return
  installed = true

  if (typeof ZodType.prototype.persist !== 'function') {
    Object.defineProperty(ZodType.prototype, 'persist', {
      configurable: true,
      writable: true,
      value: function persist() {
        this[PERSIST] = true
        return this
      },
    })
  }
  if (typeof ZodType.prototype.stream !== 'function') {
    Object.defineProperty(ZodType.prototype, 'stream', {
      configurable: true,
      writable: true,
      value: function stream() {
        this[STREAM] = true
        return this
      },
    })
  }
}

function walk(schema, flag) {
  let cur = schema
  const seen = new Set()
  while (cur && typeof cur === 'object' && !seen.has(cur)) {
    if (cur[flag]) return true
    seen.add(cur)
    const def = cur._def
    if (!def) break
    // Wrapper schemas expose their inner schema as one of these properties.
    cur = def.innerType ?? def.schema ?? def.type ?? null
  }
  return false
}

export function isPersist(schema) {
  return walk(schema, PERSIST)
}
export function isStream(schema) {
  return walk(schema, STREAM)
}

/**
 * Walk a `z.object({...})` state schema and collect the keys flagged
 * `.persist()` or `.stream()`. Both sets are mutually compatible — a key may
 * be persisted AND streamed. Streaming only affects wire serialization;
 * persistence controls restart-survival.
 */
export function collectFlaggedKeys(stateSchema) {
  const persistKeys = new Set()
  const streamKeys = new Set()
  if (!stateSchema || typeof stateSchema !== 'object') {
    return { persistKeys, streamKeys }
  }
  const shape =
    typeof stateSchema.shape === 'function' ? stateSchema.shape() : stateSchema._def?.shape?.()
  if (!shape) return { persistKeys, streamKeys }
  for (const [key, sub] of Object.entries(shape)) {
    if (isPersist(sub)) persistKeys.add(key)
    if (isStream(sub)) streamKeys.add(key)
  }
  return { persistKeys, streamKeys }
}

/**
 * Duck-type check that a value is a zod schema. We rely on the `_def` brand
 * rather than `instanceof ZodType` so a user-imported zod that resolves to a
 * different module URL still satisfies the check.
 */
export function isZodSchema(value) {
  return !!value && typeof value === 'object' && typeof value._def === 'object' && value._def !== null
}
