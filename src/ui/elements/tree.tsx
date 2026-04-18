import { useState, useCallback, useMemo } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useRef } from 'react'
import { ChevronRight, ChevronDown } from 'lucide-react'
import * as LucideIcons from 'lucide-react'
import type { TreeNode as TreeNodeType, TreeAction } from '../types'
import { useStateValue } from '../hooks'
import { useDispatch } from '../dispatch'

type TreeRow = {
  node: Record<string, unknown>
  depth: number
  id: string | number
  hasChildren: boolean
}

function flattenTree(
  nodes: Record<string, unknown>[],
  nodeKey: string,
  childrenKey: string,
  expandedSet: Set<string | number>,
  depth = 0,
): TreeRow[] {
  const rows: TreeRow[] = []
  for (const node of nodes) {
    const id = node[nodeKey] as string | number
    const children = node[childrenKey] as Record<string, unknown>[] | undefined
    const hasChildren = Array.isArray(children) && children.length > 0
    rows.push({ node, depth, id, hasChildren })
    if (hasChildren && expandedSet.has(id)) {
      rows.push(...flattenTree(children!, nodeKey, childrenKey, expandedSet, depth + 1))
    }
  }
  return rows
}

function collectAllIds(
  nodes: Record<string, unknown>[],
  nodeKey: string,
  childrenKey: string,
): (string | number)[] {
  const ids: (string | number)[] = []
  for (const node of nodes) {
    ids.push(node[nodeKey] as string | number)
    const children = node[childrenKey] as Record<string, unknown>[] | undefined
    if (Array.isArray(children) && children.length > 0) {
      ids.push(...collectAllIds(children, nodeKey, childrenKey))
    }
  }
  return ids
}

function LucideIcon({ name, size = 14 }: { name: string; size?: number }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Icon = (LucideIcons as Record<string, any>)[name]
  if (!Icon) return null
  return <Icon size={size} />
}

function ActionButton({ action, nodeData, dispatch }: { action: TreeAction; nodeData: unknown; dispatch: (fn: string, args?: unknown) => Promise<void> }) {
  return (
    <button
      className="ap-tree__action-btn"
      title={action.label}
      onClick={(e) => {
        e.stopPropagation()
        dispatch(action.onClick, action.nodeDataAs ? { [action.nodeDataAs]: nodeData } : {})
      }}
    >
      {action.icon ? <LucideIcon name={action.icon} size={12} /> : action.label}
    </button>
  )
}

export function TreeElement({ node }: { node: TreeNodeType }) {
  const data = useStateValue<Record<string, unknown>[]>(node.bind) ?? []
  const selectedId = useStateValue<string | number>(node.selectedBind)
  const dispatch = useDispatch()

  const nodeKey = node.nodeKey ?? 'id'
  const labelKey = node.labelKey ?? 'label'
  const iconKey = node.iconKey ?? ''
  const childrenKey = node.childrenKey ?? 'children'

  const [expanded, setExpanded] = useState<Set<string | number>>(() => {
    const def = node.defaultExpanded ?? 'none'
    if (def === 'all') return new Set(collectAllIds(data, nodeKey, childrenKey))
    if (def === 'none') return new Set()
    if (Array.isArray(def)) return new Set(def)
    return new Set()
  })

  const rows = useMemo(
    () => flattenTree(data, nodeKey, childrenKey, expanded),
    [data, nodeKey, childrenKey, expanded],
  )

  const parentRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 32,
    overscan: 8,
  })

  const toggleExpand = useCallback(
    (id: string | number, nodeData: unknown) => {
      setExpanded((prev) => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
      if (node.onExpand) dispatch(node.onExpand, { node: nodeData })
    },
    [node.onExpand, dispatch],
  )

  const handleSelect = useCallback(
    (id: string | number, nodeData: unknown) => {
      if (node.selectedBind) {
        dispatch('__stateSet', { key: node.selectedBind, value: id })
      }
      if (node.onSelect) dispatch(node.onSelect, { node: nodeData })
    },
    [node.selectedBind, node.onSelect, dispatch],
  )

  return (
    <div
      className="ap-tree"
      ref={parentRef}
      style={{ overflowY: 'auto', maxHeight: '60vh', position: 'relative' }}
    >
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((vRow) => {
          const { node: rowNode, depth, id, hasChildren } = rows[vRow.index]
          const label = rowNode[labelKey] as string
          const icon = iconKey ? rowNode[iconKey] as string : undefined
          const isExpanded = expanded.has(id)
          const isSelected = selectedId === id

          return (
            <div
              key={vRow.key}
              data-index={vRow.index}
              ref={virtualizer.measureElement}
              className={`ap-tree__row${isSelected ? ' ap-tree__row--selected' : ''}`}
              style={{
                position: 'absolute',
                top: 0,
                transform: `translateY(${vRow.start}px)`,
                width: '100%',
                paddingLeft: depth * 20,
              }}
              onClick={() => handleSelect(id, rowNode)}
            >
              <span
                className="ap-tree__expand-btn"
                onClick={(e) => { e.stopPropagation(); hasChildren && toggleExpand(id, rowNode) }}
                style={{ visibility: hasChildren ? 'visible' : 'hidden' }}
              >
                {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              </span>
              {icon && <span className="ap-tree__icon"><LucideIcon name={icon} size={14} /></span>}
              <span className="ap-tree__label">{label}</span>
              {node.actions?.length && (
                <span className="ap-tree__actions">
                  {node.actions.map((action, i) => (
                    <ActionButton key={i} action={action} nodeData={rowNode} dispatch={dispatch} />
                  ))}
                </span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
