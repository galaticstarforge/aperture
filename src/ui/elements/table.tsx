import { useState, useMemo, useRef, useCallback } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ChevronUp, ChevronDown } from 'lucide-react'
import type { TableNode, TableColumn, UiNode } from '../types'
import { useStateValue, useFormattedValue } from '../hooks'
import { useDispatch } from '../dispatch'
import { Element } from '../Element'

type SortDir = 'asc' | 'desc'

function CellValue({ col, value }: { col: TableColumn; value: unknown; row?: unknown }) {
  const formatted = useFormattedValue(col.format, value)
  if (col.cell) {
    return <Element node={col.cell as UiNode} />
  }
  return (
    <span style={formatted.color ? { color: formatted.color } : undefined}>
      {formatted.text !== '' ? formatted.text : value == null ? '' : String(value)}
    </span>
  )
}

function HeaderCell({
  col,
  sortKey,
  sortDir,
  onSort,
  onFilter,
  filterValue,
}: {
  col: TableColumn
  sortKey: string | null
  sortDir: SortDir
  onSort: (key: string) => void
  onFilter: (key: string, v: string) => void
  filterValue: string
}) {
  return (
    <th
      className="ap-table__th"
      style={col.width ? { width: col.width } : undefined}
    >
      <div className="ap-table__th-inner">
        <span
          className={col.sortable ? 'ap-table__th-label ap-table__th-label--sortable' : 'ap-table__th-label'}
          onClick={() => col.sortable && onSort(col.key)}
        >
          {col.label ?? col.key}
          {col.sortable && sortKey === col.key && (
            sortDir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />
          )}
        </span>
      </div>
      {col.filter && (
        <input
          className="ap-table__filter-input"
          value={filterValue}
          placeholder="Filter…"
          onChange={(e) => onFilter(col.key, e.target.value)}
        />
      )}
    </th>
  )
}

export function TableElement({ node }: { node: TableNode }) {
  const rows = useStateValue<unknown[]>(node.bind) ?? []
  const selectedIds = useStateValue<(string | number)[]>(node.selectedBind) ?? []
  const dispatch = useDispatch()

  const [sortKey, setSortKey] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [filters, setFilters] = useState<Record<string, string>>({})

  const columns = node.columns ?? []
  const rowKey = node.rowKey ?? 'id'

  const handleSort = useCallback((key: string) => {
    setSortKey((prev) => {
      if (prev === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
      else { setSortDir('asc') }
      return key
    })
  }, [])

  const handleFilter = useCallback((key: string, value: string) => {
    setFilters((prev) => ({ ...prev, [key]: value }))
  }, [])

  const filtered = useMemo(() => {
    let data = Array.isArray(rows) ? rows : []
    for (const [colKey, fv] of Object.entries(filters)) {
      if (!fv) continue
      const lower = fv.toLowerCase()
      data = data.filter((row) => {
        const v = (row as Record<string, unknown>)[colKey]
        return String(v ?? '').toLowerCase().includes(lower)
      })
    }
    return data
  }, [rows, filters])

  const sorted = useMemo(() => {
    if (!sortKey) return filtered
    return [...filtered].sort((a, b) => {
      const av = (a as Record<string, unknown>)[sortKey]
      const bv = (b as Record<string, unknown>)[sortKey]
      const cmp = String(av ?? '').localeCompare(String(bv ?? ''), undefined, { numeric: true })
      return sortDir === 'asc' ? cmp : -cmp
    })
  }, [filtered, sortKey, sortDir])

  const parentRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: sorted.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 36,
    overscan: 10,
  })

  const toggleSelect = useCallback(
    (id: string | number) => {
      if (!node.selectedBind) return
      const next = selectedIds.includes(id)
        ? selectedIds.filter((x) => x !== id)
        : [...selectedIds, id]
      dispatch('__stateSet', { key: node.selectedBind, value: next })
    },
    [selectedIds, node.selectedBind, dispatch],
  )

  const selectedRows = useMemo(
    () => sorted.filter((r) => selectedIds.includes((r as Record<string, unknown>)[rowKey] as string | number)),
    [sorted, selectedIds, rowKey],
  )

  const hasBulk = node.selectable && selectedIds.length > 0 && node.bulkActions?.length

  return (
    <div className="ap-table-wrap">
      <div className="ap-table-scroll" ref={parentRef} style={{ overflowY: 'auto', maxHeight: '60vh' }}>
        <table className="ap-table" style={{ tableLayout: 'fixed', width: '100%' }}>
          <thead className="ap-table__head">
            <tr>
              {node.selectable && <th className="ap-table__th ap-table__th--check" />}
              {columns.map((col) => (
                <HeaderCell
                  key={col.key}
                  col={col}
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onSort={handleSort}
                  onFilter={handleFilter}
                  filterValue={filters[col.key] ?? ''}
                />
              ))}
            </tr>
          </thead>
          <tbody style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((vRow) => {
              const row = sorted[vRow.index] as Record<string, unknown>
              const id = row[rowKey] as string | number
              const selected = selectedIds.includes(id)
              return (
                <tr
                  key={vRow.key}
                  className={`ap-table__row${selected ? ' ap-table__row--selected' : ''}`}
                  style={{
                    position: 'absolute',
                    top: 0,
                    transform: `translateY(${vRow.start}px)`,
                    width: '100%',
                    display: 'table',
                    tableLayout: 'fixed',
                  }}
                  data-index={vRow.index}
                  ref={virtualizer.measureElement}
                >
                  {node.selectable && (
                    <td className="ap-table__td ap-table__td--check">
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => toggleSelect(id)}
                      />
                    </td>
                  )}
                  {columns.map((col) => (
                    <td key={col.key} className="ap-table__td">
                      <CellValue col={col} value={row[col.key]} row={row} />
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {hasBulk && (
        <div className="ap-table__bulk-bar">
          <span className="ap-muted">{selectedIds.length} selected</span>
          {node.bulkActions!.map((action, i) => (
            <button
              key={i}
              className={action.variant ?? 'secondary'}
              onClick={() =>
                dispatch(action.onClick, {
                  [action.selectedAs ?? 'selected']: selectedRows,
                })
              }
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
