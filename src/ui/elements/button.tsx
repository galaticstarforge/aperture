import { useCallback } from 'react'
import type { ButtonNode } from '../types'
import { usePredicate } from '../hooks'
import { useDispatch } from '../dispatch'
import { useShortcut } from '../shortcuts'

export function ButtonElement({ node }: { node: ButtonNode }) {
  const disabled = usePredicate(node.disabledWhen, false)
  const dispatch = useDispatch()

  const handleClick = useCallback(() => {
    if (node.onClick) void dispatch(node.onClick)
  }, [dispatch, node.onClick])

  useShortcut(node.shortcut, handleClick)

  const variant = node.variant ?? 'secondary'

  return (
    <button
      className={variant}
      disabled={disabled}
      onClick={handleClick}
    >
      {node.label ?? ''}
    </button>
  )
}
