import type { ScrollNode } from '../types'
import { Element } from '../Element'

export function ScrollElement({ node }: { node: ScrollNode }) {
  return (
    <div
      className="ap-scroll"
      style={{
        maxHeight: node.maxHeight ?? 400,
        overflowY: 'auto',
        width: '100%',
      }}
    >
      {node.children?.map((child, i) => <Element key={i} node={child} />)}
    </div>
  )
}
