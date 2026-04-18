import { Activity } from 'lucide-react'

export function RunningScreen() {
  return (
    <div className="ap-screen">
      <div className="ap-center">
        <Activity size={28} className="ap-muted" />
        <div className="ap-muted">Script running…</div>
        <div className="ap-muted" style={{ fontSize: 12, textAlign: 'center', maxWidth: 520 }}>
          Phase 2 surface: <code>schema</code>, <code>state</code>, watchers, and persistence
          are live. Inspect and drive state from the dev console via
          <code style={{ margin: '0 4px' }}>window.__aperture</code>.
          UI element rendering lands in Phase 3.
        </div>
      </div>
    </div>
  )
}
