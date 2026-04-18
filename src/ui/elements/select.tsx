import { useCallback } from 'react'
import type { SelectNode, SelectOption } from '../types'
import { useStateValue, usePredicate } from '../hooks'
import { stateBridge } from '../../state-bridge'

function normalizeOptions(raw: SelectNode['options'], stateOptions: unknown): SelectOption[] {
  if (!raw) return []
  // String key → resolve from state
  if (typeof raw === 'string') {
    const arr = Array.isArray(stateOptions) ? stateOptions : []
    return arr.map((o: unknown) =>
      typeof o === 'object' && o !== null && 'value' in o
        ? (o as SelectOption)
        : { value: String(o), label: String(o) },
    )
  }
  if (!Array.isArray(raw)) return []
  return raw.map((o) =>
    typeof o === 'object' && o !== null && 'value' in o
      ? (o as SelectOption)
      : { value: String(o), label: String(o) },
  )
}

export function SelectElement({ node }: { node: SelectNode }) {
  const value = useStateValue(node.bind)
  const disabled = usePredicate(node.disabledWhen, false)
  // If options is a state-key string, resolve it live
  const optionsKey = typeof node.options === 'string' ? node.options : undefined
  const optionsFromState = useStateValue(optionsKey)
  const options = normalizeOptions(node.options, optionsFromState)

  const onChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      if (node.bind) stateBridge.setState(node.bind, e.target.value)
    },
    [node.bind],
  )

  return (
    <div className="ap-field">
      {node.label && <label className="ap-field-label">{node.label}</label>}
      <select
        className="ap-input ap-select"
        value={value == null ? '' : String(value)}
        disabled={disabled}
        onChange={onChange}
      >
        {options.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  )
}
