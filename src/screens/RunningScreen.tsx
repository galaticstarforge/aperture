import { UiRoot } from '../ui/UiRoot'
import type { LogEntry } from '../ui/LogPanel'
import { type ModalRequest } from '../ui/InvokeModal'
import type { UiNode } from '../ui/types'
import type { ProgressState } from '../types'

interface Props {
  uiTree: UiNode | null
  cwd: string
  logEntries: LogEntry[]
  progress: ProgressState
  modal: ModalRequest | null
  onModalConfirm: (callId: string, value?: string) => void
  onModalCancel:  (callId: string) => void
}

export function RunningScreen({ uiTree, cwd, logEntries, progress, modal, onModalConfirm, onModalCancel }: Props) {
  return (
    <div className="ap-screen">
      <UiRoot
        tree={uiTree}
        cwd={cwd}
        logEntries={logEntries}
        progress={progress}
        modal={modal}
        onModalConfirm={onModalConfirm}
        onModalCancel={onModalCancel}
      />
    </div>
  )
}
