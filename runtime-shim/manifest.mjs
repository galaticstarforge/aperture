// ScriptManifest — extract the full export surface from the user's module.
//
// Phase 2 consumes `schema` and `state`; downstream phases pick up `ui`,
// `formatters`, `meta`, `deps`, `env`, `window` from the same struct so they
// don't have to re-read the module.

import { isZodSchema } from './schema-markers.mjs'

export class ManifestError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ManifestError'
  }
}

export function extractManifest(userModule) {
  const schema = userModule.schema
  const state = userModule.state
  if (schema !== undefined && !isZodSchema(schema)) {
    throw new ManifestError(
      '`export const schema` must be a zod schema (got: ' + typeName(schema) + ')',
    )
  }
  if (state !== undefined && !isZodSchema(state)) {
    throw new ManifestError(
      '`export const state` must be a zod schema (got: ' + typeName(state) + ')',
    )
  }
  const callbacks = {}
  for (const [k, v] of Object.entries(userModule)) {
    if (typeof v === 'function' && !RESERVED_EXPORTS.has(k)) {
      callbacks[k] = v
    }
  }
  return {
    deps: Array.isArray(userModule.deps) ? userModule.deps : [],
    env: Array.isArray(userModule.env) ? userModule.env : [],
    window: isPlainObject(userModule.window) ? userModule.window : {},
    schema: schema ?? null,
    state: state ?? null,
    ui: userModule.ui ?? {},
    formatters: isPlainObject(userModule.formatters) ? userModule.formatters : {},
    meta: isPlainObject(userModule.meta) ? userModule.meta : {},
    onLoad: typeof userModule.onLoad === 'function' ? userModule.onLoad : null,
    onExit: typeof userModule.onExit === 'function' ? userModule.onExit : null,
    headless: typeof userModule.headless === 'function' ? userModule.headless : null,
    timeoutMs: typeof userModule.timeoutMs === 'number' && userModule.timeoutMs > 0
      ? userModule.timeoutMs
      : null,
    callbacks,
  }
}

const RESERVED_EXPORTS = new Set([
  'onLoad',
  'onExit',
  'headless',
  // Non-callback reserved names — defensively filtered even though these are
  // usually non-functions.
  'deps',
  'env',
  'window',
  'schema',
  'state',
  'ui',
  'formatters',
  'meta',
  'timeoutMs',
  'default',
])

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function typeName(v) {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v
}

/**
 * Build the initial state object:
 *   1. `state.parse({})`           — apply all schema defaults
 *   2. overlay persisted snapshot  — if present on disk
 *   3. overlay schema-backed keys  — any validated params key whose name also
 *                                    appears in state (enables `from:'schema'`
 *                                    inputs to resolve against state by that
 *                                    name)
 *
 * Returns a plain `{key: value}` object.
 */
export function buildInitialState({ stateSchema, persistedSnapshot, validatedParams }) {
  let base = {}
  if (stateSchema) {
    // `state.parse({})` applies `.default()` entries; keys without defaults
    // become undefined and are filtered out.
    try {
      base = stateSchema.parse({})
    } catch {
      // Schema has required fields with no defaults — fall through with an
      // empty base; persist / params will likely fill them.
      base = {}
    }
  }
  const out = { ...base }
  if (persistedSnapshot && typeof persistedSnapshot === 'object') {
    for (const [k, v] of Object.entries(persistedSnapshot)) {
      if (k in out || !stateSchema) out[k] = v
      else if (hasStateKey(stateSchema, k)) out[k] = v
    }
  }
  if (validatedParams && stateSchema) {
    for (const [k, v] of Object.entries(validatedParams)) {
      if (hasStateKey(stateSchema, k)) out[k] = v
    }
  }
  return out
}

function hasStateKey(stateSchema, key) {
  const shape =
    typeof stateSchema.shape === 'function' ? stateSchema.shape() : stateSchema._def?.shape?.()
  return !!shape && key in shape
}
