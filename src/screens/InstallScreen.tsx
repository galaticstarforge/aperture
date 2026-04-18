import { Loader2 } from 'lucide-react'

export function InstallScreen({ label }: { label: string }) {
  return (
    <div className="ap-screen">
      <div className="ap-center">
        <Loader2 size={28} className="ap-muted" style={{ animation: 'ap-spin 1s linear infinite' }} />
        <div style={{ fontSize: 15 }}>{label}</div>
        <div className="ap-progress-indeterminate" />
      </div>
      <style>{`@keyframes ap-spin { to { transform: rotate(360deg) } }`}</style>
    </div>
  )
}
