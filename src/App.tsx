import { useCallback, useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { invoke as tauriInvoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type { BackendMessage, InvokeRequest, ProgressState, ScriptEvent, WindowConfig } from './types'
import { InstallScreen } from './screens/InstallScreen'
import { RunningScreen } from './screens/RunningScreen'
import { DeathScreen, type DeathInfo } from './screens/DeathScreen'
import { stateBridge, installDevHandle } from './state-bridge'
import { type LogEntry, makeLogId } from './ui/LogPanel'
import { type ModalRequest } from './ui/InvokeModal'
import type { UiNode } from './ui/types'
import { resolveFormatResult, registerCustomFormatters } from './ui/formatters'

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

// Send an invoke:result back to the child process.
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
  const scriptSourceRef = useRef('')
  // Track custom formatter names so applyFormatter can route requests.
  const customFormattersRef = useRef<string[]>([])

  const pushLog = useCallback((entry: Omit<LogEntry, 'id' | 'timestamp'>) => {
    setLogEntries((prev) => [
      ...prev,
      { ...entry, id: makeLogId(), timestamp: Date.now() },
    ])
  }, [])

  // Handle invoke events from the script.
  const handleInvoke = useCallback(
    async (req: InvokeRequest) => {
      try {
        switch (req.fn) {
          case 'confirm': {
            // Show React modal — resolved when user clicks OK/Cancel.
            setModal({ kind: 'confirm', message: req.args.message, callId: req.callId })
            return // result sent by onConfirm/onCancel handlers
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
    [],
  )

  const onModalConfirm = useCallback(
    async (callId: string, value?: string) => {
      setModal(null)
      if (value !== undefined) {
        // prompt
        await sendInvokeResult(callId, { confirmed: true, value })
      } else {
        // confirm
        await sendInvokeResult(callId, { confirmed: true })
      }
    },
    [],
  )

  const onModalCancel = useCallback(async (callId: string) => {
    setModal(null)
    // confirm → confirmed:false; prompt → confirmed:false, value:undefined
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
          void applyWindowConfig(event.window, scriptSourceRef.current)
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
          // Worker requesting state from main thread via GUI bridge.
          const value = stateBridge.get((event as { key: string }).key)
          void tauriInvoke('send_to_child', {
            event: { type: 'state:get:reply', callId: (event as { callId: string }).callId, value },
          }).catch(() => {})
          return
        }
        case 'invoke':
          // Script is requesting an OS-level primitive.
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
