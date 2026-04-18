import { useCallback, useEffect, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { invoke as tauriInvoke } from '@tauri-apps/api/core'
import type { BackendMessage, ScriptEvent } from './types'
import { InstallScreen } from './screens/InstallScreen'
import { RunningScreen } from './screens/RunningScreen'
import { DeathScreen, type DeathInfo } from './screens/DeathScreen'
import { stateBridge, installDevHandle } from './state-bridge'

type View =
  | { kind: 'installing'; label: string }
  | { kind: 'running' }
  | { kind: 'dead'; info: DeathInfo }

export default function App() {
  const [view, setView] = useState<View>({ kind: 'installing', label: 'Installing dependencies…' })

  const handleScriptEvent = useCallback((event: ScriptEvent) => {
    switch (event.type) {
      case 'error':
        setView({ kind: 'dead', info: { message: event.message, stack: event.stack } })
        return
      case 'result':
        // First result dismisses the scrim; Phase 3 will render real UI here.
        return
      case 'log':
        // Phase 3 introduces a real log panel; for now bubble to devtools.
        // eslint-disable-next-line no-console
        console.log(`[script:${event.level}]`, event.message, event.data ?? '')
        return
      case 'state:set':
        stateBridge.ingestScriptSet(event.key, event.value)
        return
      case 'state:set:chunk':
        // Backend transparently reassembles chunks into `state-set` backend
        // messages, so this branch shouldn't normally fire. If it does, the
        // chunk arrived out-of-band (e.g. dev-mode bypass) — warn and drop.
        // eslint-disable-next-line no-console
        console.warn('[script:event] unexpected raw state:set:chunk', event)
        return
      default:
        // Every other ScriptEvent is logged and ignored until its phase lands.
        // eslint-disable-next-line no-console
        console.debug('[script:event]', event)
    }
  }, [])

  useEffect(() => {
    const unlistenPromise = listen<BackendMessage>('aperture://message', (evt) => {
      const msg = evt.payload
      switch (msg.kind) {
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
          // Mirror to devtools so Phase 2 acceptance can be eyeballed.
          // eslint-disable-next-line no-console
          console.debug('[state:set]', msg.key, msg.value)
          return
        case 'stderr':
          // eslint-disable-next-line no-console
          console.log('[stderr]', msg.line)
          return
        case 'parse-error':
          // eslint-disable-next-line no-console
          console.warn('[ndjson:parse-error]', msg.error, msg.line)
          return
        case 'child-exit':
          if (msg.code !== 0 || msg.signal) {
            setView((prev) => {
              // A structured `error` event already set up the death screen
              // with the real message/stack — don't clobber it with the less
              // informative exit code summary.
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
        case 'launch':
          // Informational for now.
          // eslint-disable-next-line no-console
          console.debug('[launch]', msg)
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
  }, [handleScriptEvent])

  const reload = useCallback(async () => {
    setView({ kind: 'installing', label: 'Reloading…' })
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

  switch (view.kind) {
    case 'installing':
      return <InstallScreen label={view.label} />
    case 'running':
      return <RunningScreen />
    case 'dead':
      return <DeathScreen info={view.info} onReload={reload} />
  }
}
