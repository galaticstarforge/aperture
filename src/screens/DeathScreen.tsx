import { AlertOctagon, RefreshCw, FileText } from 'lucide-react'
import { invoke as tauriInvoke } from '@tauri-apps/api/core'

export type DeathInfo = {
  message: string
  stack?: string
  logAvailable?: boolean
}

export function DeathScreen({ info, onReload }: { info: DeathInfo; onReload: () => void }) {
  const handleShowLog = async () => {
    await tauriInvoke('open_log_file').catch((err) => {
      // eslint-disable-next-line no-console
      console.warn('[death-screen] open_log_file failed', err)
    })
  }

  return (
    <div className="ap-screen">
      <div className="ap-death">
        <div className="ap-death-header">
          <AlertOctagon size={20} />
          <span>Script crashed</span>
        </div>
        <div className="ap-death-message">{info.message}</div>
        {info.stack ? (
          <pre className="ap-death-stack">{info.stack}</pre>
        ) : (
          <div className="ap-muted" style={{ fontFamily: 'var(--ap-mono)', fontSize: 12 }}>
            (no stack trace captured)
          </div>
        )}
        <div className="ap-death-actions">
          <button className="primary" onClick={onReload} title="Cmd/Ctrl+R">
            <RefreshCw size={14} style={{ verticalAlign: -2, marginRight: 6 }} />
            Reload Script
          </button>
          {info.logAvailable && (
            <button onClick={handleShowLog} title="Open stderr log file">
              <FileText size={14} style={{ verticalAlign: -2, marginRight: 6 }} />
              Show log
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
