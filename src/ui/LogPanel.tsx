import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { ChevronDown, ChevronUp, ChevronRight, Terminal } from 'lucide-react'

export type LogEntry = {
  id: number
  level: 'info' | 'warn' | 'error' | 'stderr'
  message: string
  data?: unknown
  timestamp: number
  source?: string
}

const LEVEL_COLOR: Record<string, string> = {
  info: 'var(--ap-text-dim)',
  warn: 'var(--ap-warning)',
  error: 'var(--ap-danger)',
  stderr: 'var(--ap-text-dim)',
}

const LEVEL_BADGE: Record<string, string> = {
  info: 'INFO',
  warn: 'WARN',
  error: 'ERR ',
  stderr: 'STDE',
}

let idSeq = 0
export function makeLogId(): number { return ++idSeq }

function DataBlob({ data }: { data: unknown }) {
  const [open, setOpen] = useState(false)
  let preview: string
  try {
    preview = JSON.stringify(data)
    if (preview.length > 60) preview = preview.slice(0, 57) + '…'
  } catch {
    preview = String(data)
  }

  return (
    <span className="ap-log-entry__data-wrap">
      <button
        className="ap-log-entry__data-toggle ap-muted"
        onClick={() => setOpen((o) => !o)}
        title={open ? 'Collapse data' : 'Expand data'}
      >
        <ChevronRight
          size={10}
          style={{ transform: open ? 'rotate(90deg)' : undefined, transition: 'transform 0.1s' }}
        />
        {!open && <span className="ap-log-entry__data-preview">{preview}</span>}
      </button>
      {open && (
        <pre className="ap-log-entry__data-json">
          {JSON.stringify(data, null, 2)}
        </pre>
      )}
    </span>
  )
}

function LogEntryRow({ entry }: { entry: LogEntry }) {
  return (
    <div className="ap-log-entry">
      <span
        className="ap-log-entry__badge"
        style={{ color: LEVEL_COLOR[entry.level] }}
      >
        {LEVEL_BADGE[entry.level]}
      </span>
      {entry.source && entry.source !== 'main' && (
        <span className="ap-log-entry__source ap-muted">[{entry.source}]</span>
      )}
      <span className="ap-log-entry__msg">{entry.message}</span>
      {entry.data !== undefined && <DataBlob data={entry.data} />}
    </div>
  )
}

export function LogPanel({ entries }: { entries: LogEntry[] }) {
  const [open, setOpen] = useState(false)
  const [sourceFilter, setSourceFilter] = useState<string>('all')
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open) bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [entries, open])

  const toggleOpen = useCallback(() => setOpen((o) => !o), [])

  const sources = useMemo(() => {
    const seen = new Set<string>(['main'])
    for (const e of entries) {
      if (e.source && e.source !== 'main') seen.add(e.source)
    }
    return Array.from(seen)
  }, [entries])

  const visible = useMemo(
    () => sourceFilter === 'all' ? entries : entries.filter((e) => (e.source ?? 'main') === sourceFilter),
    [entries, sourceFilter],
  )

  const multiSource = sources.length > 1

  return (
    <div className={`ap-log-panel${open ? ' ap-log-panel--open' : ''}`}>
      <button className="ap-log-panel__toggle" onClick={toggleOpen}>
        <Terminal size={12} style={{ marginRight: 6 }} />
        <span>Logs</span>
        {entries.length > 0 && (
          <span className="ap-log-panel__count">{entries.length}</span>
        )}
        {open ? <ChevronDown size={12} style={{ marginLeft: 'auto' }} /> : <ChevronUp size={12} style={{ marginLeft: 'auto' }} />}
      </button>

      {open && (
        <div className="ap-log-panel__body">
          {multiSource && (
            <div className="ap-log-panel__source-filter">
              <select
                value={sourceFilter}
                onChange={(e) => setSourceFilter(e.target.value)}
                className="ap-log-panel__source-select"
              >
                <option value="all">All sources</option>
                {sources.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
          )}
          {visible.length === 0 && (
            <div className="ap-muted" style={{ padding: '8px 12px', fontSize: 12 }}>No log output yet.</div>
          )}
          {visible.map((e) => (
            <LogEntryRow key={e.id} entry={e} />
          ))}
          <div ref={bottomRef} />
        </div>
      )}
    </div>
  )
}
