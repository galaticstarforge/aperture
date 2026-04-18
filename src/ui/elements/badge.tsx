import type { BadgeNode } from '../types'
import { useStateValue } from '../hooks'
import { resolveColor } from '../color'

export function BadgeElement({ node }: { node: BadgeNode }) {
  const val = useStateValue(node.bind)
  const key = val == null ? '' : String(val)
  const colorRaw = node.variants?.[key]
  const color = resolveColor(colorRaw)

  return (
    <span
      className="ap-badge"
      style={color ? { background: color, borderColor: color } : undefined}
    >
      {key}
    </span>
  )
}
