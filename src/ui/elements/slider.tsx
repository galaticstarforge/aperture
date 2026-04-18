import { useCallback } from 'react'
import type { SliderNode } from '../types'
import { useStateValue, usePredicate } from '../hooks'
import { stateBridge } from '../../state-bridge'

export function SliderElement({ node }: { node: SliderNode }) {
  const value = useStateValue<number>(node.bind) ?? node.min ?? 0
  const disabled = usePredicate(node.disabledWhen, false)

  const onChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (node.bind) stateBridge.setState(node.bind, parseFloat(e.target.value))
    },
    [node.bind],
  )

  return (
    <div className="ap-field">
      {node.label && (
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <label className="ap-field-label">{node.label}</label>
          <span className="ap-field-label">{value}</span>
        </div>
      )}
      <input
        type="range"
        className="ap-slider"
        value={value}
        min={node.min ?? 0}
        max={node.max ?? 100}
        step={node.step ?? 1}
        disabled={disabled}
        onChange={onChange}
      />
    </div>
  )
}
