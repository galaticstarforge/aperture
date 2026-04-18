import { useCallback } from 'react'
import type { InputNode } from '../types'
import { useStateValue, usePredicate } from '../hooks'
import { stateBridge } from '../../state-bridge'
import { useShortcut } from '../shortcuts'

export function InputElement({ node }: { node: InputNode }) {
  const value = useStateValue<string>(node.bind) ?? ''
  const disabled = usePredicate(node.disabledWhen, false)

  const onChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (node.bind) stateBridge.setState(node.bind, e.target.value)
    },
    [node.bind],
  )

  const ref = useCallback((el: HTMLInputElement | null) => {
    if (!el) return
  }, [])

  useShortcut(node.shortcut, () => {
    document.querySelector<HTMLInputElement>(`input[data-bind="${node.bind}"]`)?.focus()
  })

  return (
    <div className="ap-field">
      {node.label && <label className="ap-field-label">{node.label}</label>}
      <input
        ref={ref}
        className="ap-input"
        type={node.inputType ?? 'text'}
        value={value}
        placeholder={node.placeholder}
        disabled={disabled}
        onChange={onChange}
        data-bind={node.bind}
      />
    </div>
  )
}
