import { createContext, useContext } from 'react'
import { invoke as tauriInvoke } from '@tauri-apps/api/core'

export type DispatchFn = (fn: string, args?: unknown) => Promise<void>

export const DispatchContext = createContext<DispatchFn>(() => Promise.resolve())

export function useDispatch(): DispatchFn {
  return useContext(DispatchContext)
}

let seq = 0
export function nextCallId(): string {
  return `c${Date.now()}-${++seq}`
}

export function makeDispatch(): DispatchFn {
  return async (fn: string, args: unknown = {}) => {
    // __stateSet is an internal UI action: update a state key directly.
    if (fn === '__stateSet') {
      const { key, value } = args as { key: string; value: unknown }
      await tauriInvoke('send_to_child', {
        event: { type: 'state:changed', key, value },
      }).catch((err) => {
        console.warn('[dispatch] state:changed failed', err)
      })
      return
    }
    const callId = nextCallId()
    await tauriInvoke('send_to_child', {
      event: { type: 'call', fn, args, callId },
    }).catch((err) => {
      console.warn('[dispatch] send_to_child failed', err)
    })
  }
}
