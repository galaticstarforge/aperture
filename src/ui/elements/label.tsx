import type { LabelNode } from '../types'
import { useStateValue } from '../hooks'
import { applyFormat } from '../formatters'

export function LabelElement({ node }: { node: LabelNode }) {
  const val = useStateValue(node.bind)
  const text = node.bind != null ? val : node.text
  const display = applyFormat(text, node.format)

  return <span className="ap-label">{display}</span>
}
