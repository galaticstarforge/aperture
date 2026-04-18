import type { ColumnNode } from '../types'
import { Element } from '../Element'

export function ColumnElement({ node }: { node: ColumnNode }) {
  return (
    <div
      className="ap-column"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: node.gap ?? 12,
        alignItems: node.align ?? 'stretch',
        width: '100%',
      }}
    >
      {node.children?.map((child, i) => <Element key={i} node={child} />)}
    </div>
  )
}
