import type { RowNode } from '../types'
import { Element } from '../Element'

export function RowElement({ node }: { node: RowNode }) {
  return (
    <div
      className="ap-row"
      style={{
        display: 'flex',
        flexDirection: 'row',
        gap: node.gap ?? 8,
        alignItems: node.align ?? 'center',
        justifyContent: node.justify ?? 'flex-start',
        flexWrap: 'wrap',
      }}
    >
      {node.children?.map((child, i) => <Element key={i} node={child} />)}
    </div>
  )
}
