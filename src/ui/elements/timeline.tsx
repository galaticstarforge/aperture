import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowDown } from 'lucide-react'
import type { TimelineNode, TimelineEvent } from '../types'
import { useStateValue } from '../hooks'
import { useDispatch } from '../dispatch'

const LEVEL_COLORS: Record<string, string> = {
  info: 'var(--ap-info)',
  warn: 'var(--ap-warning)',
  error: 'var(--ap-danger)',
  debug: 'var(--ap-text-dim)',
}

const ALL_LEVELS = ['info', 'warn', 'error', 'debug'] as const

function formatTs(ts: number, format: TimelineNode['timestampFormat'], firstTs: number): string {
  if (format === 'absolute') {
    return new Date(ts).toLocaleTimeString()
  }
  if (format === 'elapsed') {
    const ms = ts - firstTs
    if (ms < 1000) return `+${ms}ms`
    return `+${(ms / 1000).toFixed(1)}s`
  }
  // relative (default)
  const diff = Date.now() - ts
  if (diff < 5000) return 'just now'
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  return `${Math.floor(diff / 3600000)}h ago`
}

export function TimelineElement({ node }: { node: TimelineNode }) {
  const events = useStateValue<TimelineEvent[]>(node.bind) ?? []
  const dispatch = useDispatch()

  const [enabledLevels, setEnabledLevels] = useState<Set<string>>(new Set(ALL_LEVELS))
  const [userScrolled, setUserScrolled] = useState(false)
  const [tick, setTick] = useState(0)

  // Refresh timestamps every second for relative mode
  useEffect(() => {
    if (node.timestampFormat !== 'absolute' && node.timestampFormat !== 'elapsed') {
      const id = setInterval(() => setTick((t) => t + 1), 1000)
      return () => clearInterval(id)
    }
  }, [node.timestampFormat])

  const filtered = useMemo(
    () => events.filter((e) => enabledLevels.has(e.level ?? 'info')),
    [events, enabledLevels],
  )

  const firstTs = filtered[0]?.timestamp ?? Date.now()

  const parentRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 40,
    overscan: 10,
  })

  // Auto-scroll to bottom when new events arrive
  useEffect(() => {
    if (node.autoScroll !== false && !userScrolled && filtered.length > 0) {
      virtualizer.scrollToIndex(filtered.length - 1, { align: 'end' })
    }
  }, [filtered.length, node.autoScroll, userScrolled, virtualizer])

  const handleScroll = useCallback(() => {
    const el = parentRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    setUserScrolled(!atBottom)
  }, [])

  const jumpToLatest = useCallback(() => {
    virtualizer.scrollToIndex(filtered.length - 1, { align: 'end' })
    setUserScrolled(false)
  }, [filtered.length, virtualizer])

  const toggleLevel = useCallback((level: string) => {
    setEnabledLevels((prev) => {
      const next = new Set(prev)
      if (next.has(level)) next.delete(level)
      else next.add(level)
      return next
    })
  }, [])

  // Suppress unused tick lint; tick is used to force re-render for relative timestamps
  void tick

  return (
    <div className="ap-timeline">
      {node.filterLevels && (
        <div className="ap-timeline__filters">
          {ALL_LEVELS.map((level) => (
            <button
              key={level}
              className={`ap-timeline__filter-pill${enabledLevels.has(level) ? ' ap-timeline__filter-pill--on' : ''}`}
              style={{ borderColor: LEVEL_COLORS[level] }}
              onClick={() => toggleLevel(level)}
            >
              {level}
            </button>
          ))}
        </div>
      )}

      <div
        className="ap-timeline__scroll"
        ref={parentRef}
        onScroll={handleScroll}
        style={{ overflowY: 'auto', maxHeight: '60vh', position: 'relative' }}
      >
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((vRow) => {
            const evt = filtered[vRow.index]
            const level = evt.level ?? 'info'
            const ts = formatTs(evt.timestamp, node.timestampFormat, firstTs)

            return (
              <div
                key={vRow.key}
                data-index={vRow.index}
                ref={virtualizer.measureElement}
                className="ap-timeline__event"
                style={{
                  position: 'absolute',
                  top: 0,
                  transform: `translateY(${vRow.start}px)`,
                  width: '100%',
                  cursor: node.onClick ? 'pointer' : undefined,
                }}
                onClick={node.onClick ? () => dispatch(node.onClick!, { [node.eventDataAs ?? 'event']: evt }) : undefined}
              >
                <span
                  className="ap-timeline__level"
                  style={{ color: LEVEL_COLORS[level] }}
                >
                  {level.toUpperCase().padEnd(5)}
                </span>
                <span className="ap-timeline__ts ap-muted">{ts}</span>
                <span className="ap-timeline__msg">{evt.message}</span>
                {evt.source && <span className="ap-timeline__source ap-muted">[{evt.source}]</span>}
              </div>
            )
          })}
        </div>
      </div>

      {userScrolled && (
        <button className="ap-timeline__jump-btn" onClick={jumpToLatest}>
          <ArrowDown size={12} />
          Jump to latest
        </button>
      )}
    </div>
  )
}
