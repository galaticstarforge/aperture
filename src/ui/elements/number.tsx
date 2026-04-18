import { useCallback } from 'react'
import type { NumberNode } from '../types'
import { useStateValue, usePredicate } from '../hooks'
import { stateBridge } from '../../state-bridge'

export function NumberElement({ node }: { node: NumberNode }) {
  const value = useStateValue<number>(node.bind)
  const disabled = usePredicate(node.disabledWhen, false)

  const onChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (!node.bind) return
      const n = parseFloat(e.target.value)
      stateBridge.setState(node.bind, isNaN(n) ? null : n)
    },
    [node.bind],
  )

  return (
    <div className="ap-field">
      {node.label && <label className="ap-field-label">{node.label}</label>}
      <input
        className="ap-input"
        type="number"
        value={value ?? ''}
        min={node.min}
        max={node.max}
        step={node.step ?? 1}
        disabled={disabled}
        onChange={onChange}
      />
    </div>
  )
}
