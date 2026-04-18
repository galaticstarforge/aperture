import { useCallback, useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { invoke as tauriInvoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type { BackendMessage, ScriptEvent, WindowConfig } from './types'
import { InstallScreen } from './screens/InstallScreen'
import { RunningScreen } from './screens/RunningScreen'
import { DeathScreen, type DeathInfo } from './screens/DeathScreen'
import { stateBridge, installDevHandle } from './state-bridge'
import { type LogEntry, makeLogId } from './ui/LogPanel'
import type { UiNode } from './ui/types'

type View =
  | { kind: 'installing'; label: string }
  | { kind: 'running' }
  | { kind: 'dead'; info: DeathInfo }

async function applyWindowConfig(cfg: WindowConfig, scriptSource: string) {
  const win = getCurrentWindow()
  const title = cfg.title ?? scriptSource.split('/').pop()?.replace(/\.mjs$/, '') ?? 'Aperture'
  try {
    await win.setTitle(title)
    if (cfg.width && cfg.height) {
      const { LogicalSize } = await import('@tauri-apps/api/dpi')
      await win.setSize(new LogicalSize(cfg.width, cfg.height))
    }
    if (cfg.resizable !== undefined) await win.setResizable(cfg.resizable)
    if (cfg.minWidth && cfg.minHeight) {
      const { LogicalSize } = await import('@tauri-apps/api/dpi')
      await win.setMinSize(new LogicalSize(cfg.minWidth, cfg.minHeight))
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[window-config]', err)
  }
}

export default function App() {
  const [view, setView] = useState<View>({ kind: 'installing', label: 'Installing dependencies…' })
  const [uiTree, setUiTree] = useState<UiNode | null>(null)
  const [logEntries, setLogEntries] = useState<LogEntry[]>([])
  const [cwd, setCwd] = useState('')
  const scriptSourceRef = useRef('')

  const pushLog = useCallback((entry: Omit<LogEntry, 'id' | 'timestamp'>) => {
    setLogEntries((prev) => [
      ...prev,
      { ...entry, id: makeLogId(), timestamp: Date.now() },
    ])
  }, [])

  const handleScriptEvent = useCallback(
    (event: ScriptEvent) => {
      switch (event.type) {
        case 'error':
          setView({ kind: 'dead', info: { message: event.message, stack: event.stack } })
          return
        case 'result':
          // onLoad completed — dismiss install scrim if still visible.
          setView((prev) => (prev.kind === 'installing' ? { kind: 'running' } : prev))
          return
        case 'log':
          pushLog({ level: event.level, message: event.message, data: event.data })
          return
        case 'manifest':
          setUiTree(event.ui as UiNode)
          void applyWindowConfig(event.window, scriptSourceRef.current)
          return
        case 'ui:update':
          setUiTree(event.tree as UiNode)
          return
        case 'state:set':
          stateBridge.ingestScriptSet(event.key, event.value)
          return
        case 'state:set:chunk':
          // eslint-disable-next-line no-console
          console.warn('[script:event] unexpected raw state:set:chunk', event)
          return
        default:
          // eslint-disable-next-line no-console
          console.debug('[script:event]', event)
      }
    },
    [pushLog],
  )

  useEffect(() => {
    const unlistenPromise = listen<BackendMessage>('aperture://message', (evt) => {
      const msg = evt.payload
      switch (msg.kind) {
        case 'launch':
          setCwd(msg.cwd)
          scriptSourceRef.current = msg.source
          return
        case 'phase':
          if (msg.phase === 'installing') {
            setView({ kind: 'installing', label: 'Installing dependencies…' })
          } else if (msg.phase === 'running') {
            setView({ kind: 'running' })
          }
          return
        case 'script':
          handleScriptEvent(msg.event)
          return
        case 'state-set':
          stateBridge.ingestScriptSet(msg.key, msg.value)
          // eslint-disable-next-line no-console
          console.debug('[state:set]', msg.key, msg.value)
          return
        case 'stderr':
          pushLog({ level: 'stderr', message: msg.line })
          return
        case 'parse-error':
          // eslint-disable-next-line no-console
          console.warn('[ndjson:parse-error]', msg.error, msg.line)
          return
        case 'child-exit':
          if (msg.code !== 0 || msg.signal) {
            setView((prev) => {
              if (prev.kind === 'dead') return prev
              return {
                kind: 'dead',
                info: {
                  message: `Script exited with ${msg.code ?? 'null'}${msg.signal ? ` (signal ${msg.signal})` : ''}`,
                  stack: msg.stderrTail || undefined,
                },
              }
            })
          }
          return
        case 'fatal':
          setView({ kind: 'dead', info: { message: msg.message, stack: msg.stack } })
          return
      }
    })

    installDevHandle()
    tauriInvoke('frontend_ready').catch((err) => {
      // eslint-disable-next-line no-console
      console.error('frontend_ready failed', err)
    })

    return () => {
      unlistenPromise.then((off) => off()).catch(() => {})
    }
  }, [handleScriptEvent, pushLog])

  const reload = useCallback(async () => {
    setView({ kind: 'installing', label: 'Reloading…' })
    setUiTree(null)
    setLogEntries([])
    try {
      await tauriInvoke('reload_script')
    } catch (err) {
      setView({
        kind: 'dead',
        info: { message: `Reload failed: ${String(err)}` },
      })
    }
  }, [])

  // Cmd/Ctrl+R — kept here so it fires on every screen, not just RunningScreen.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'r') {
        e.preventDefault()
        void reload()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [reload])

  switch (view.kind) {
    case 'installing':
      return <InstallScreen label={view.label} />
    case 'running':
      return <RunningScreen uiTree={uiTree} cwd={cwd} logEntries={logEntries} />
    case 'dead':
      return <DeathScreen info={view.info} onReload={reload} />
  }
}
