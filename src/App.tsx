import { useCallback, useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { invoke as tauriInvoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type { BackendMessage, InvokeRequest, ProgressState, ScriptEvent, WindowConfig, WindowGeometry } from './types'
import { InstallScreen } from './screens/InstallScreen'
import { RunningScreen } from './screens/RunningScreen'
import { DeathScreen, type DeathInfo } from './screens/DeathScreen'
import { EnvApprovalScreen } from './screens/EnvApprovalScreen'
import { stateBridge, installDevHandle } from './state-bridge'
import { type LogEntry, makeLogId } from './ui/LogPanel'
import { type ModalRequest } from './ui/InvokeModal'
import { ProtocolInspector, type ProtocolEntry, makeProtocolId } from './ui/ProtocolInspector'
import type { UiNode } from './ui/types'
import { resolveFormatResult, registerCustomFormatters } from './ui/formatters'

type View =
  | { kind: 'installing'; label: string }
  | { kind: 'env-approval'; vars: string[]; cacheKey: string }
  | { kind: 'running' }
  | { kind: 'dead'; info: DeathInfo }

async function applyWindowConfig(
  cfg: WindowConfig,
  scriptSource: string,
  persisted: WindowGeometry | null | undefined,
) {
  const win = getCurrentWindow()
  const title = cfg.title ?? scriptSource.split('/').pop()?.replace(/\.mjs$/, '') ?? 'Aperture'
  try {
    await win.setTitle(title)
    // Persisted geometry wins over script defaults (Phase 6 §"Window persistence").
    const w = persisted?.width ?? cfg.width
    const h = persisted?.height ?? cfg.height
    if (w && h) {
      const { LogicalSize } = await import('@tauri-apps/api/dpi')
      await win.setSize(new LogicalSize(w, h))
    }
    if (persisted?.x !== undefined && persisted?.y !== undefined) {
      const { LogicalPosition } = await import('@tauri-apps/api/dpi')
      await win.setPosition(new LogicalPosition(persisted.x, persisted.y))
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

async function sendInvokeResult(callId: string, result?: unknown, error?: string) {
  const event = error
    ? { type: 'invoke:result', callId, error }
    : { type: 'invoke:result', callId, result }
  await tauriInvoke('send_to_child', { event }).catch((err) => {
    // eslint-disable-next-line no-console
    console.warn('[invoke:result] send_to_child failed', err)
  })
}

export default function App() {
  const [view, setView] = useState<View>({ kind: 'installing', label: 'Installing dependencies…' })
  const [uiTree, setUiTree] = useState<UiNode | null>(null)
  const [logEntries, setLogEntries] = useState<LogEntry[]>([])
  const [progress, setProgress] = useState<ProgressState>(null)
  const [modal, setModal] = useState<ModalRequest | null>(null)
  const [cwd, setCwd] = useState('')
  const [devMode, setDevMode] = useState(false)
  const [showInspector, setShowInspector] = useState(false)
  const [protocolEntries, setProtocolEntries] = useState<ProtocolEntry[]>([])

  const scriptSourceRef = useRef('')
  const persistedGeometryRef = useRef<WindowGeometry | null>(null)
  const customFormattersRef = useRef<string[]>([])

  // Window geometry persistence — debounced 500 ms write after resize/move.
  const geometryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const saveGeometry = useCallback(async () => {
    try {
      const win = getCurrentWindow()
      const { width, height } = await win.outerSize()
      const { x, y } = await win.outerPosition()
      await tauriInvoke('save_window_geometry', { width, height, x, y })
    } catch {
      // non-fatal
    }
  }, [])

  // Attach resize/move listeners after the window is ready.
  useEffect(() => {
    const win = getCurrentWindow()
    let unlisten: (() => void) | null = null
    const handler = () => {
      if (geometryTimerRef.current) clearTimeout(geometryTimerRef.current)
      geometryTimerRef.current = setTimeout(saveGeometry, 500)
    }
    const attach = async () => {
      const off1 = await win.onResized(handler)
      const off2 = await win.onMoved(handler)
      unlisten = () => { off1(); off2() }
    }
    void attach()
    return () => {
      if (unlisten) unlisten()
      if (geometryTimerRef.current) clearTimeout(geometryTimerRef.current)
    }
  }, [saveGeometry])

  const addProtocolEntry = useCallback((direction: 'inbound' | 'outbound', event: unknown) => {
    setProtocolEntries((prev) => {
      // Cap at 500 entries to avoid unbounded growth.
      const next = [...prev, { id: makeProtocolId(), ts: Date.now(), direction, event }]
      return next.length > 500 ? next.slice(next.length - 500) : next
    })
  }, [])

  const pushLog = useCallback((entry: Omit<LogEntry, 'id' | 'timestamp'>) => {
    setLogEntries((prev) => [
      ...prev,
      { ...entry, id: makeLogId(), timestamp: Date.now() },
    ])
  }, [])

  const handleInvoke = useCallback(
    async (req: InvokeRequest) => {
      // In dev mode, record outbound invoke requests in the protocol inspector.
      if (devMode) {
        addProtocolEntry('outbound', { type: 'invoke', fn: req.fn, callId: req.callId })
      }
      try {
        switch (req.fn) {
          case 'confirm': {
            setModal({ kind: 'confirm', message: req.args.message, callId: req.callId })
            return
          }
          case 'prompt': {
            setModal({ kind: 'prompt', message: req.args.message, callId: req.callId })
            return
          }
          case 'filePicker': {
            const result = await tauriInvoke<{ paths: string[] } | null>(
              'aperture_file_picker',
              { mode: req.args.mode ?? 'file', filter: req.args.filter ?? null },
            )
            if (result === null) {
              await sendInvokeResult(req.callId, { paths: [], cancelled: true })
            } else {
              await sendInvokeResult(req.callId, result)
            }
            return
          }
          case 'notification': {
            await tauriInvoke('aperture_notification', {
              title: req.args.title,
              body: req.args.body ?? '',
              level: req.args.level ?? 'info',
            })
            await sendInvokeResult(req.callId, { sent: true })
            return
          }
          case 'openExternal': {
            await tauriInvoke('aperture_open_external', { url: req.args.url })
            await sendInvokeResult(req.callId, { opened: true })
            return
          }
          case 'clipboard': {
            if (req.args.op === 'read') {
              const text = await tauriInvoke<string>('aperture_clipboard_read')
              await sendInvokeResult(req.callId, text)
            } else {
              await tauriInvoke('aperture_clipboard_write', { text: req.args.text ?? '' })
              await sendInvokeResult(req.callId, { written: true })
            }
            return
          }
          default: {
            const unknown = req as { fn: string; callId: string }
            await sendInvokeResult(unknown.callId, undefined, `Unknown invoke fn: ${unknown.fn}`)
          }
        }
      } catch (err) {
        const anyReq = req as { callId: string }
        await sendInvokeResult(anyReq.callId, undefined, String(err))
      }
    },
    [devMode, addProtocolEntry],
  )

  const onModalConfirm = useCallback(
    async (callId: string, value?: string) => {
      setModal(null)
      if (value !== undefined) {
        await sendInvokeResult(callId, { confirmed: true, value })
      } else {
        await sendInvokeResult(callId, { confirmed: true })
      }
    },
    [],
  )

  const onModalCancel = useCallback(async (callId: string) => {
    setModal(null)
    await sendInvokeResult(callId, { confirmed: false })
  }, [])

  const handleScriptEvent = useCallback(
    (event: ScriptEvent) => {
      switch (event.type) {
        case 'error':
          setView({ kind: 'dead', info: { message: event.message, stack: event.stack } })
          return
        case 'result':
          setView((prev) => (prev.kind === 'installing' ? { kind: 'running' } : prev))
          return
        case 'log':
          pushLog({ level: event.level, message: event.message, data: event.data, source: event.source })
          return
        case 'progress':
          setProgress({ value: event.value, label: event.label })
          return
        case 'manifest':
          setUiTree(event.ui as UiNode)
          void applyWindowConfig(event.window, scriptSourceRef.current, persistedGeometryRef.current)
          customFormattersRef.current = event.formatters ?? []
          registerCustomFormatters(event.formatters ?? [])
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
        case 'state:get': {
          const value = stateBridge.get((event as { key: string }).key)
          void tauriInvoke('send_to_child', {
            event: { type: 'state:get:reply', callId: (event as { callId: string }).callId, value },
          }).catch(() => {})
          return
        }
        case 'invoke':
          void handleInvoke(event as unknown as InvokeRequest)
          return
        case 'format:result':
          resolveFormatResult(event.callId, event.result, event.error)
          return
        default:
          // eslint-disable-next-line no-console
          console.debug('[script:event]', event)
      }
    },
    [pushLog, handleInvoke],
  )

  useEffect(() => {
    const unlistenPromise = listen<BackendMessage>('aperture://message', (evt) => {
      const msg = evt.payload
      switch (msg.kind) {
        case 'launch':
          setCwd(msg.cwd)
          scriptSourceRef.current = msg.source
          persistedGeometryRef.current = msg.persistedGeometry ?? null
          setDevMode(msg.devMode)
          if (msg.devMode) setShowInspector(true)
          return
        case 'phase':
          if (msg.phase === 'installing') {
            setView({ kind: 'installing', label: 'Installing dependencies…' })
          } else if (msg.phase === 'running') {
            setView((prev) => prev.kind === 'env-approval' ? prev : { kind: 'running' })
          }
          return
        case 'install-progress':
          setView({ kind: 'installing', label: msg.label })
          return
        case 'env-approval':
          setView({ kind: 'env-approval', vars: msg.vars, cacheKey: msg.cacheKey })
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
                  logAvailable: msg.logAvailable,
                },
              }
            })
          }
          return
        case 'fatal':
          setView({ kind: 'dead', info: { message: msg.message, stack: msg.stack } })
          return
        case 'protocol-event':
          if (devMode) {
            addProtocolEntry(msg.direction as 'inbound' | 'outbound', msg.event)
          }
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
  }, [handleScriptEvent, pushLog, devMode, addProtocolEntry])

  const reload = useCallback(async () => {
    setView({ kind: 'installing', label: 'Reloading…' })
    setUiTree(null)
    setLogEntries([])
    setProgress(null)
    setModal(null)
    try {
      await tauriInvoke('reload_script')
    } catch (err) {
      setView({
        kind: 'dead',
        info: { message: `Reload failed: ${String(err)}` },
      })
    }
  }, [])

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

  const renderView = () => {
    switch (view.kind) {
      case 'installing':
        return <InstallScreen label={view.label} />
      case 'env-approval':
        return (
          <EnvApprovalScreen
            vars={view.vars}
            cacheKey={view.cacheKey}
            onApproved={() => setView({ kind: 'installing', label: 'Starting…' })}
            onDenied={() => setView({ kind: 'dead', info: { message: 'Env-var access denied.' } })}
          />
        )
      case 'running':
        return (
          <RunningScreen
            uiTree={uiTree}
            cwd={cwd}
            logEntries={logEntries}
            progress={progress}
            modal={modal}
            onModalConfirm={onModalConfirm}
            onModalCancel={onModalCancel}
          />
        )
      case 'dead':
        return <DeathScreen info={view.info} onReload={reload} />
    }
  }

  return (
    <>
      {renderView()}
      {devMode && showInspector && (
        <ProtocolInspector
          entries={protocolEntries}
          onClose={() => setShowInspector(false)}
        />
      )}
      {devMode && !showInspector && (
        <button
          onClick={() => setShowInspector(true)}
          style={{
            position: 'fixed',
            bottom: 8,
            right: 8,
            fontSize: 10,
            padding: '3px 8px',
            background: '#1a1a1a',
            border: '1px solid #444',
            color: '#888',
            cursor: 'pointer',
            borderRadius: 3,
            zIndex: 9998,
          }}
        >
          inspector
        </button>
      )}
    </>
  )
}
