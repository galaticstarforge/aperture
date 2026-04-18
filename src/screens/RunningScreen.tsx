import { UiRoot } from '../ui/UiRoot'
import type { LogEntry } from '../ui/LogPanel'
import type { UiNode } from '../ui/types'

interface Props {
  uiTree: UiNode | null
  cwd: string
  logEntries: LogEntry[]
}

export function RunningScreen({ uiTree, cwd, logEntries }: Props) {
  return (
    <div className="ap-screen">
      <UiRoot tree={uiTree} cwd={cwd} logEntries={logEntries} />
    </div>
  )
}
