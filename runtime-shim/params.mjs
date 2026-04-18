// Launch-time param resolution.
//
// The backend hands us a merged object of `{ query: {...}, flags: {...} }`
// (URL query params from the script-source URL + CLI flag pairs). Per
// design.md §"Param Wire Format": CLI wins on collision; complex values are
// JSON-parsed per key with a fall-back to the raw string.
//
// The merged + coerced object is then validated with `schema.safeParse(...)`.
// On success we freeze it as `runtime.params`; on failure we surface the full
// zod issue list via a structured `error` event so the death screen can
// render it.

/**
 * Coerce one raw string value. Returns the parsed JSON if the string looks
 * like JSON (`{`/`[`/`"`/number/bool/null); otherwise the raw string.
 */
export function coerceValue(raw) {
  if (typeof raw !== 'string') return raw
  const s = raw.trim()
  if (s === '') return ''
  const first = s[0]
  const looksJson =
    first === '{' ||
    first === '[' ||
    first === '"' ||
    first === '-' ||
    (first >= '0' && first <= '9') ||
    s === 'true' ||
    s === 'false' ||
    s === 'null'
  if (!looksJson) return raw
  try {
    return JSON.parse(s)
  } catch {
    return raw
  }
}

/**
 * Merge URL query (lowest priority) and CLI flags (highest) into a single
 * coerced object. Missing inputs default to empty.
 */
export function mergeRawParams({ query, flags }) {
  const out = {}
  for (const [k, v] of Object.entries(query ?? {})) {
    out[k] = coerceValue(v)
  }
  for (const [k, v] of Object.entries(flags ?? {})) {
    out[k] = coerceValue(v) // CLI wins
  }
  return out
}

/**
 * Validate a merged object against a zod schema. Returns
 *   { ok: true, data }              on success
 *   { ok: false, issues: [...] }    on failure, where each issue is
 *                                   `{ path, message, code }` tuned for the
 *                                   death screen.
 */
export function validateParams(schema, merged) {
  if (!schema) {
    // No schema export — pass merged through untouched.
    return { ok: true, data: merged }
  }
  const result = schema.safeParse(merged)
  if (result.success) return { ok: true, data: result.data }
  const issues = (result.error?.issues ?? []).map((i) => ({
    path: (i.path ?? []).join('.') || '<root>',
    message: i.message ?? String(i),
    code: i.code ?? 'invalid',
  }))
  return { ok: false, issues }
}

/**
 * Parse a script-source URL and return its query string as a flat
 * `{key: string}` object. Accepts `http(s)://...` and `file://...`. For any
 * other shape (like a bare path the CLI already resolved), returns `{}`.
 */
export function queryFromSource(source) {
  if (typeof source !== 'string' || source === '') return {}
  try {
    const u = new URL(source)
    const out = {}
    for (const [k, v] of u.searchParams.entries()) out[k] = v
    return out
  } catch {
    return {}
  }
}
