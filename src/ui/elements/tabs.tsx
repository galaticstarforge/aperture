import { useState } from 'react'
import type { TabsNode, TabItem } from '../types'
import { usePredicate } from '../hooks'
import { Element } from '../Element'

function TabStripItem({
  item,
  active,
  onSelect,
}: {
  item: TabItem
  active: boolean
  onSelect: () => void
}) {
  const visible = usePredicate(item.visibleWhen)
  if (!visible && !item.keepAlive) return null
  return (
    <button
      className={`ap-tabs__tab${active ? ' ap-tabs__tab--active' : ''}`}
      onClick={onSelect}
    >
      {item.label}
    </button>
  )
}

function TabPanelItem({ item, active }: { item: TabItem; active: boolean }) {
  const visible = usePredicate(item.visibleWhen)

  if (!visible) {
    if (!item.keepAlive) return null
    // keepAlive — keep mounted but hidden so scroll position is preserved
    return (
      <div style={{ display: 'none' }}>
        {item.children?.map((c, i) => <Element key={i} node={c} />)}
      </div>
    )
  }

  return (
    <div
      className="ap-tabs__panel"
      style={{ display: active ? undefined : 'none' }}
    >
      {item.children?.map((child, i) => <Element key={i} node={child} />)}
    </div>
  )
}

export function TabsElement({ node }: { node: TabsNode }) {
  const items = node.items ?? []
  const [activeIdx, setActiveIdx] = useState(0)

  return (
    <div className="ap-tabs">
      <div className="ap-tabs__strip">
        {items.map((item, i) => (
          <TabStripItem
            key={i}
            item={item}
            active={activeIdx === i}
            onSelect={() => setActiveIdx(i)}
          />
        ))}
      </div>
      <div className="ap-tabs__panels">
        {items.map((item, i) => (
          <TabPanelItem key={i} item={item} active={activeIdx === i} />
        ))}
      </div>
    </div>
  )
}
