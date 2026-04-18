// Dev-mode protocol inspector — shows every inbound/outbound NDJSON event
// with timestamps and type-based filtering.
import { useState, useRef, useEffect, useCallback } from 'react'

export type ProtocolEntry = {
  id: number
  ts: number
  direction: 'inbound' | 'outbound'
  event: unknown
}

let _seq = 0
export function makeProtocolId() { return ++_seq }

export function ProtocolInspector({
  entries,
  onClose,
}: {
  entries: ProtocolEntry[]
  onClose: () => void
}) {
  const [filter, setFilter] = useState('')
  const [paused, setPaused] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  const visible = entries.filter((e) => {
    if (!filter) return true
    const type = (e.event as Record<string, unknown>)?.type
    return typeof type === 'string' && type.includes(filter)
  })

  useEffect(() => {
    if (!paused) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [entries, paused])

  const fmt = useCallback((e: unknown) => {
    try { return JSON.stringify(e) } catch { return String(e) }
  }, [])

  return (
    <div style={{
      position: 'fixed',
      bottom: 0,
      left: 0,
      right: 0,
      height: 220,
      background: '#0d0d0d',
      borderTop: '1px solid #333',
      display: 'flex',
      flexDirection: 'column',
      zIndex: 9999,
      fontFamily: 'var(--ap-mono, monospace)',
      fontSize: 11,
    }}>
      {/* Header bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px', borderBottom: '1px solid #222', background: '#141414' }}>
        <span style={{ color: '#888', fontWeight: 600 }}>PROTOCOL INSPECTOR</span>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="filter by type…"
          style={{ flex: 1, background: '#1a1a1a', border: '1px solid #333', color: '#ccc', padding: '2px 6px', borderRadius: 3, fontSize: 11 }}
        />
        <span style={{ color: '#555', fontSize: 10 }}>{visible.length}/{entries.length}</span>
        <button
          onClick={() => setPaused((p) => !p)}
          style={{ fontSize: 10, padding: '2px 6px', background: paused ? '#333' : 'transparent', border: '1px solid #444', color: '#888', cursor: 'pointer', borderRadius: 3 }}
        >
          {paused ? '▶ resume' : '⏸ pause'}
        </button>
        <button
          onClick={onClose}
          style={{ fontSize: 10, padding: '2px 6px', background: 'transparent', border: '1px solid #444', color: '#888', cursor: 'pointer', borderRadius: 3 }}
          title="Close inspector"
        >
          ✕
        </button>
      </div>
      {/* Event list */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
        {visible.map((e) => {
          const ts = new Date(e.ts).toISOString().slice(11, 23)
          const type = (e.event as Record<string, unknown>)?.type ?? '?'
          const color = e.direction === 'inbound' ? '#4ec9b0' : '#9cdcfe'
          return (
            <div key={e.id} style={{ display: 'flex', gap: 8, padding: '1px 8px', lineHeight: 1.5 }}>
              <span style={{ color: '#555', minWidth: 90 }}>{ts}</span>
              <span style={{ color, minWidth: 70 }}>{e.direction === 'inbound' ? '← in' : '→ out'}</span>
              <span style={{ color: '#ddd', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                <span style={{ color: '#ce9178' }}>{String(type)}</span>
                {' '}
                {fmt(e.event)}
              </span>
            </div>
          )
        })}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
