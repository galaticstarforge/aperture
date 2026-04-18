import type { Predicate } from './types'

export type { Predicate }

export function evaluatePredicate(
  pred: Predicate | undefined,
  state: Record<string, unknown>,
  defaultValue = true,
): boolean {
  if (pred == null) return defaultValue
  if (typeof pred === 'string') return Boolean(state[pred])
  const v = state[pred.bind]
  if ('value' in pred) return v === pred.value
  if ('gt' in pred && pred.gt !== undefined) return Number(v) > pred.gt
  if ('lt' in pred && pred.lt !== undefined) return Number(v) < pred.lt
  if ('gte' in pred && pred.gte !== undefined) return Number(v) >= pred.gte
  if ('lte' in pred && pred.lte !== undefined) return Number(v) <= pred.lte
  if ('not' in pred) return v !== pred.not
  return defaultValue
}

export function predicateKey(pred: Predicate | undefined): string | null {
  if (pred == null) return null
  if (typeof pred === 'string') return pred
  return pred.bind ?? null
}
