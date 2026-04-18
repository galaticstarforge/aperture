import type { ProgressNode } from '../types'
import { useStateValue } from '../hooks'

export function ProgressElement({ node }: { node: ProgressNode }) {
  const val = useStateValue<number>(node.bind) ?? 0
  const indeterminate = node.indeterminate ?? false

  if (indeterminate) {
    return <div className="ap-progress-indeterminate" />
  }

  const pct = Math.min(1, Math.max(0, val)) * 100

  return (
    <div className="ap-progress-bar">
      <div className="ap-progress-bar__fill" style={{ width: `${pct}%` }} />
    </div>
  )
}
