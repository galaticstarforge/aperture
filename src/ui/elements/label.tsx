import type { LabelNode } from '../types'
import { useStateValue, useFormattedValue } from '../hooks'

export function LabelElement({ node }: { node: LabelNode }) {
  const val = useStateValue(node.bind)
  const raw = node.bind != null ? val : node.text
  const { text, color, loading } = useFormattedValue(node.format, raw)

  return (
    <span
      className="ap-label"
      style={{
        color: color ?? undefined,
        opacity: loading ? 0.4 : undefined,
        transition: loading ? undefined : 'opacity 0.15s',
      }}
    >
      {text}
    </span>
  )
}
