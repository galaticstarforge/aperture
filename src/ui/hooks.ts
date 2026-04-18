import { useState, useEffect } from 'react'
import { stateBridge } from '../state-bridge'
import { evaluatePredicate, predicateKey } from './predicate'
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
