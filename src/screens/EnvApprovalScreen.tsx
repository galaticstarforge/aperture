// Pre-launch env-var approval dialog.
// Shows when a script declares `export const env = ['MY_KEY', ...]`
// and the user has not yet approved access.
import { invoke as tauriInvoke } from '@tauri-apps/api/core'

export function EnvApprovalScreen({
  vars,
  onApproved,
  onDenied,
}: {
  vars: string[]
  cacheKey: string
  onApproved: () => void
  onDenied: () => void
}) {
  const handleApprove = async () => {
    await tauriInvoke('env_approve', { approved: true, vars })
    onApproved()
  }

  const handleDeny = async () => {
    await tauriInvoke('env_approve', { approved: false, vars: [] })
    onDenied()
  }

  return (
    <div className="ap-screen">
      <div className="ap-death" style={{ maxWidth: 480 }}>
        <div className="ap-death-header" style={{ color: 'var(--ap-fg)' }}>
          <span>Environment variable access</span>
        </div>
        <div style={{ fontSize: 14, lineHeight: 1.6, marginBottom: 12 }}>
          This script requests access to the following environment variables from your terminal:
        </div>
        <div style={{ background: 'var(--ap-surface)', borderRadius: 6, padding: '8px 12px', marginBottom: 16 }}>
          {vars.map((v) => (
            <div key={v} style={{ fontFamily: 'var(--ap-mono)', fontSize: 13, padding: '2px 0', color: 'var(--ap-fg)' }}>
              {v}
            </div>
          ))}
        </div>
        <div className="ap-muted" style={{ fontSize: 12, marginBottom: 16 }}>
          Variable values are never shown. Access is saved and won&apos;t prompt again for this script version.
        </div>
        <div className="ap-death-actions">
          <button className="primary" onClick={handleApprove}>
            Allow access
          </button>
          <button onClick={handleDeny}>
            Deny
          </button>
        </div>
      </div>
    </div>
  )
}
