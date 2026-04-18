import { useState, useRef, useEffect } from 'react'
import { ChevronDown, ChevronUp, Terminal } from 'lucide-react'

export type LogEntry = {
  id: number
  level: 'info' | 'warn' | 'error' | 'stderr'
  message: string
  data?: unknown
  timestamp: number
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

export function LogPanel({ entries }: { entries: LogEntry[] }) {
  const [open, setOpen] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open) bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [entries, open])

  return (
    <div className={`ap-log-panel${open ? ' ap-log-panel--open' : ''}`}>
      <button className="ap-log-panel__toggle" onClick={() => setOpen((o) => !o)}>
        <Terminal size={12} style={{ marginRight: 6 }} />
        <span>Logs</span>
        {entries.length > 0 && (
          <span className="ap-log-panel__count">{entries.length}</span>
        )}
        {open ? <ChevronDown size={12} style={{ marginLeft: 'auto' }} /> : <ChevronUp size={12} style={{ marginLeft: 'auto' }} />}
      </button>

      {open && (
        <div className="ap-log-panel__body">
          {entries.length === 0 && (
            <div className="ap-muted" style={{ padding: '8px 12px', fontSize: 12 }}>No log output yet.</div>
          )}
          {entries.map((e) => (
            <div key={e.id} className="ap-log-entry">
              <span
                className="ap-log-entry__badge"
                style={{ color: LEVEL_COLOR[e.level] }}
              >
                {LEVEL_BADGE[e.level]}
              </span>
              <span className="ap-log-entry__msg">{e.message}</span>
              {e.data !== undefined && (
                <span className="ap-log-entry__data ap-muted">
                  {' '}{JSON.stringify(e.data)}
                </span>
              )}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      )}
    </div>
  )
}
