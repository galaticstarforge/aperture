import { Activity } from 'lucide-react'

export function RunningScreen() {
  return (
    <div className="ap-screen">
      <div className="ap-center">
        <Activity size={28} className="ap-muted" />
        <div className="ap-muted">Script running…</div>
        <div className="ap-muted" style={{ fontSize: 12 }}>
          UI element rendering arrives in Phase 3.
        </div>
      </div>
    </div>
  )
}
