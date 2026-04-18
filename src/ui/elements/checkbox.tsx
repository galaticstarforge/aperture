import { useCallback } from 'react'
import type { CheckboxNode } from '../types'
import { useStateValue, usePredicate } from '../hooks'
import { stateBridge } from '../../state-bridge'

export function CheckboxElement({ node }: { node: CheckboxNode }) {
  const checked = Boolean(useStateValue(node.bind))
  const disabled = usePredicate(node.disabledWhen, false)

  const onChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (node.bind) stateBridge.setState(node.bind, e.target.checked)
    },
    [node.bind],
  )

  return (
    <label className="ap-checkbox-wrap" style={{ opacity: disabled ? 0.5 : 1 }}>
      <input
        type="checkbox"
        className="ap-checkbox"
        checked={checked}
        disabled={disabled}
        onChange={onChange}
      />
      {node.label && <span>{node.label}</span>}
    </label>
  )
}
