import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { CardNode } from '../types'
import { Element } from '../Element'
import { ButtonElement } from './button'
import type { ButtonNode } from '../types'

const VARIANT_BORDER: Record<string, string> = {
  info: 'var(--ap-info)',
  danger: 'var(--ap-danger)',
  default: 'var(--ap-border)',
}

export function CardElement({ node }: { node: CardNode }) {
  const [collapsed, setCollapsed] = useState(false)
  const borderColor = VARIANT_BORDER[node.variant ?? 'default'] ?? VARIANT_BORDER.default

  return (
    <div
      className="ap-card"
      style={{ borderColor }}
    >
      {(node.title || node.collapsible || node.actions?.length) && (
        <div className="ap-card__header">
          <div className="ap-card__title-row">
            {node.collapsible && (
              <button
                className="ap-card__collapse-btn"
                onClick={() => setCollapsed((c) => !c)}
                aria-label={collapsed ? 'Expand' : 'Collapse'}
              >
                {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
              </button>
            )}
            {node.title && <span className="ap-card__title">{node.title}</span>}
          </div>
          {node.actions?.length && (
            <div className="ap-card__actions">
              {node.actions.map((action, i) => (
                <ButtonElement key={i} node={action as ButtonNode} />
              ))}
            </div>
          )}
        </div>
      )}

      {!collapsed && (
        <div
          className="ap-card__body"
          style={{ padding: node.padding ?? 16 }}
        >
          {node.children?.map((child, i) => <Element key={i} node={child} />)}
        </div>
      )}

      {!collapsed && node.footer?.length && (
        <div className="ap-card__footer">
          {node.footer.map((child, i) => <Element key={i} node={child} />)}
        </div>
      )}
    </div>
  )
}
