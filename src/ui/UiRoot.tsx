import type { ReactNode } from 'react'
import { ShortcutProvider } from './shortcuts'
import { DispatchContext, makeDispatch } from './dispatch'
import { CwdContext } from './cwd'
import { Element } from './Element'
import { LogPanel, type LogEntry } from './LogPanel'
import type { UiNode } from './types'

const dispatch = makeDispatch()

export function UiRoot({
  tree,
  cwd,
  logEntries,
}: {
  tree: UiNode | null
  cwd: string
  logEntries: LogEntry[]
}) {
  return (
    <ShortcutProvider>
      <DispatchContext.Provider value={dispatch}>
        <CwdContext.Provider value={cwd}>
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
