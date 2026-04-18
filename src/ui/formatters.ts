import { invoke as tauriInvoke } from '@tauri-apps/api/core'
import { resolveColor } from './color'

// Built-in formatter set.
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

const BUILTIN: Record<string, (v: unknown) => string> = {
  bytes(v) {
    const n = Number(v)
    if (!isFinite(n)) return String(v)
    let i = 0
    let x = Math.abs(n)
    while (x >= 1024 && i < UNITS.length - 1) { x /= 1024; i++ }
    return `${(Math.sign(n) * x).toFixed(i === 0 ? 0 : 1)} ${UNITS[i]}`
  },
  ms(v) {
    const n = Number(v)
    if (!isFinite(n)) return String(v)
    if (n < 1000) return `${n.toFixed(0)}ms`
    if (n < 60_000) return `${(n / 1000).toFixed(1)}s`
    return `${(n / 60_000).toFixed(1)}m`
  },
  date(v) {
    try {
      return new Date(v as string).toLocaleString()
    } catch {
      return String(v)
    }
  },
  number(v) {
    const n = Number(v)
    return isFinite(n) ? n.toLocaleString() : String(v)
  },
  percent(v) {
    const n = Number(v)
    if (!isFinite(n)) return String(v)
    return `${(n * 100).toFixed(1)}%`
  },
  relative(v) {
    try {
      const ms = Date.now() - new Date(v as string).getTime()
      const abs = Math.abs(ms)
      if (abs < 60_000) return 'just now'
      if (abs < 3_600_000) return `${Math.round(abs / 60_000)}m ago`
      if (abs < 86_400_000) return `${Math.round(abs / 3_600_000)}h ago`
      return `${Math.round(abs / 86_400_000)}d ago`
    } catch {
      return String(v)
    }
  },
}

// --- Custom formatter registry -----------------------------------------------

// Set of custom formatter names declared by the current script.
let _customNames: Set<string> = new Set()

export function registerCustomFormatters(names: string[]) {
  _customNames = new Set(names)
}

// --- Async format memo cache (LRU-bounded to 1000 entries per spec) ----------

type RichResult = { text: string; color?: string }
type FormatResult = string | RichResult

const MEMO_LIMIT = 1000
// LRU order: oldest keys first; we evict when over the limit.
const _memo = new Map<string, FormatResult>()

function memoKey(name: string, value: unknown, context: unknown): string {
  try {
    return `${name}:${JSON.stringify(value)}:${JSON.stringify(context ?? null)}`
  } catch {
    return `${name}:${String(value)}:{}`
  }
}

function memoSet(key: string, value: FormatResult) {
  _memo.delete(key) // remove-then-re-insert for LRU ordering
  _memo.set(key, value)
  if (_memo.size > MEMO_LIMIT) {
    const oldest = _memo.keys().next().value
    if (oldest !== undefined) _memo.delete(oldest)
  }
}

// --- Pending format requests -------------------------------------------------

type ResolveFn = (result: FormatResult) => void
const _pending = new Map<string, ResolveFn[]>()
const _rerender = new Set<() => void>()

let _fmtSeq = 0
function nextFmtCallId(): string {
  return `fmt-${Date.now()}-${++_fmtSeq}`
}

// Called by App.tsx when a format:result arrives from the child.
export function resolveFormatResult(callId: string, result: unknown, error?: string) {
  const resolvers = _pending.get(callId)
  if (!resolvers) return
  _pending.delete(callId)

  let resolved: FormatResult
  if (error || result === undefined || result === null) {
    resolved = error ? `[fmt error: ${error}]` : ''
  } else if (
    typeof result === 'object' &&
    'text' in (result as object) &&
    typeof (result as { text: unknown }).text === 'string'
  ) {
    const r = result as { text: string; color?: string }
    resolved = { text: r.text, color: r.color }
  } else {
    resolved = String(result)
  }

  // Store in memo under every key the resolvers registered with.
  // (Resolvers are grouped by callId; the key is stored with them.)
  for (const fn of resolvers) fn(resolved)

  // Notify all subscribed re-render callbacks.
  for (const cb of _rerender) cb()
}

// Subscribe to any format result (used by useFormattedValue).
export function subscribeRerender(cb: () => void): () => void {
  _rerender.add(cb)
  return () => _rerender.delete(cb)
}

// Sentinel to signal "this value is loading — show shimmer."
export const SHIMMER = Symbol('shimmer')

// --- Main resolver -----------------------------------------------------------

/**
 * Apply a named formatter to `value`.
 *
 * Returns:
 *   - `SHIMMER` when a custom formatter request is in-flight (no memo hit yet).
 *   - `string` for sync results (built-ins or memo hits).
 *   - `RichResult` for rich sync or cached rich results.
 *
 * The caller must subscribe via `subscribeRerender` to re-render when the
 * in-flight request resolves.
 */
export function applyFormatter(
  name: string | undefined,
  value: unknown,
  context?: unknown,
): typeof SHIMMER | FormatResult {
  if (!name) return value == null ? '' : String(value)

  // Check if this is a custom formatter (overrides built-in if present).
  const isCustom = _customNames.has(name)

  if (!isCustom) {
    // Built-in path (synchronous).
    const fn = BUILTIN[name]
    if (fn) return fn(value)
    // Unknown: warn and return raw.
    console.warn(`[formatters] unknown formatter: ${name}`)
    return value == null ? '' : String(value)
  }

  // Custom formatter: check memo cache first.
  const key = memoKey(name, value, context)
  const cached = _memo.get(key)
  if (cached !== undefined) {
    // LRU: re-insert to mark as recently used.
    _memo.delete(key)
    _memo.set(key, cached)
    return cached
  }

  // Dispatch a format:request to the child process.
  const callId = nextFmtCallId()
  _pending.set(callId, [
    (result) => memoSet(key, result),
  ])

  tauriInvoke('send_to_child', {
    event: { type: 'format:request', callId, name, value, context: context ?? null },
  }).catch((err) => {
    // If dispatch fails, evict from pending and log.
    _pending.delete(callId)
    console.warn('[formatters] format:request dispatch failed', err)
  })

  return SHIMMER
}

// --- Legacy helper kept for built-in-only callers (Phase 3 elements) ---------

export function applyFormat(value: unknown, format: string | undefined): string {
  if (!format) return value == null ? '' : String(value)
  const result = applyFormatter(format, value)
  if (result === SHIMMER) return value == null ? '' : String(value)
  if (typeof result === 'object') return result.text
  return result
}

// --- Rich result renderer helper ---------------------------------------------

export function renderFormatResult(
  result: typeof SHIMMER | FormatResult,
  fallback: string,
): { text: string; color?: string; loading: boolean } {
  if (result === SHIMMER) return { text: fallback, loading: true }
  if (typeof result === 'object') {
    return { text: result.text, color: resolveColor(result.color), loading: false }
  }
  return { text: result, loading: false }
}
