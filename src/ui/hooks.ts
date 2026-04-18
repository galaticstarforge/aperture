import { useState, useEffect, useCallback } from 'react'
import { stateBridge } from '../state-bridge'
import { evaluatePredicate, predicateKey } from './predicate'
import { applyFormatter, subscribeRerender, SHIMMER, renderFormatResult } from './formatters'
import type { Predicate } from './types'

export function useStateValue<T = unknown>(key: string | undefined): T | undefined {
  const [val, setVal] = useState<T | undefined>(() =>
    key != null ? (stateBridge.get(key) as T | undefined) : undefined,
  )
  useEffect(() => {
    if (key == null) return
    setVal(stateBridge.get(key) as T | undefined)
    return stateBridge.subscribe(key, (v) => setVal(v as T))
  }, [key])
  return val
}

export function usePredicate(pred: Predicate | undefined, defaultValue = true): boolean {
  const key = predicateKey(pred) ?? undefined
  const val = useStateValue(key)
  if (pred == null) return defaultValue
  const ctx: Record<string, unknown> = key != null ? { [key]: val } : {}
  return evaluatePredicate(pred, ctx, defaultValue)
}

/**
 * Apply a named formatter to a value, handling async custom formatters.
 *
 * Returns `{ text, color?, loading }`.  When `loading` is true, the caller
 * should render with shimmer opacity until the value resolves.
 */
export function useFormattedValue(
  format: string | undefined,
  value: unknown,
  context?: unknown,
): { text: string; color?: string; loading: boolean } {
  const fallback = value == null ? '' : String(value)

  // Rerender counter forces a re-evaluation when a pending format resolves.
  const [, setTick] = useState(0)
  const bump = useCallback(() => setTick((t) => t + 1), [])

  useEffect(() => {
    if (!format) return
    return subscribeRerender(bump)
  }, [format, bump])

  const result = applyFormatter(format, value, context)
  return renderFormatResult(result === SHIMMER ? SHIMMER : result, fallback)
}
