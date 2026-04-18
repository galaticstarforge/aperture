import { useCallback } from 'react'
import type { TextareaNode } from '../types'
import { useStateValue, usePredicate } from '../hooks'
import { stateBridge } from '../../state-bridge'

export function TextareaElement({ node }: { node: TextareaNode }) {
  const value = useStateValue<string>(node.bind) ?? ''
  const disabled = usePredicate(node.disabledWhen, false)

  const onChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      if (node.bind) stateBridge.setState(node.bind, e.target.value)
    },
    [node.bind],
  )

  return (
    <div className="ap-field">
      {node.label && <label className="ap-field-label">{node.label}</label>}
      <textarea
        className="ap-input ap-textarea"
        rows={node.rows ?? 4}
        value={value}
        disabled={disabled}
        onChange={onChange}
        style={{ resize: node.resizable === false ? 'none' : 'vertical' }}
      />
    </div>
  )
}
