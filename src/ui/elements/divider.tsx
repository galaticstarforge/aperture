import type { DividerNode } from '../types'

export function DividerElement({ node }: { node: DividerNode }) {
  if (node.label) {
    return (
      <div className="ap-divider ap-divider--labeled">
        <span className="ap-divider__label">{node.label}</span>
      </div>
    )
  }
  return <hr className="ap-divider" />
}
