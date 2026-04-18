import type { ReactNode } from 'react'
import { ShortcutProvider } from './shortcuts'
import { DispatchContext, makeDispatch } from './dispatch'
import { CwdContext } from './cwd'
import { Element } from './Element'
import { LogPanel, type LogEntry } from './LogPanel'
import { ProgressBar } from './ProgressBar'
import { InvokeModal, type ModalRequest } from './InvokeModal'
import type { UiNode } from './types'
import type { ProgressState } from '../types'

const dispatch = makeDispatch()

interface Props {
  tree: UiNode | null
  cwd: string
  logEntries: LogEntry[]
  progress: ProgressState
  modal: ModalRequest | null
  onModalConfirm: (callId: string, value?: string) => void
  onModalCancel:  (callId: string) => void
}

export function UiRoot({ tree, cwd, logEntries, progress, modal, onModalConfirm, onModalCancel }: Props) {
  return (
    <ShortcutProvider>
      <DispatchContext.Provider value={dispatch}>
        <CwdContext.Provider value={cwd}>
          <ProgressBar progress={progress} />
          <div className="ap-ui-root">
            {tree ? (
              <div className="ap-ui-canvas">
                <Element node={tree} />
              </div>
            ) : (
              <EmptyCanvas />
            )}
          </div>
          <LogPanel entries={logEntries} />
          <InvokeModal request={modal} onConfirm={onModalConfirm} onCancel={onModalCancel} />
        </CwdContext.Provider>
      </DispatchContext.Provider>
    </ShortcutProvider>
  )
}

function EmptyCanvas(): ReactNode {
  return (
    <div className="ap-center ap-muted" style={{ flex: 1 }}>
      Script running — no UI defined.
    </div>
  )
}
