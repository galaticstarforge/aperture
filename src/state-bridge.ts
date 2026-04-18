// State bridge — the frontend side of Phase 2's reactive-state wiring.
//
// Responsibilities:
//   1. Maintain a shadow map of `key → value` mirrored from script-side
//      `state:set` events (which may have been reassembled from chunks on
//      the backend).
//   2. Coalesce GUI-originated writes to at most one `state:changed`
//      message per key per ~16ms window, via requestAnimationFrame.
//   3. Expose a `setState(key, value)` entry point that downstream UI
//      (Phase 3) — and the Phase 2 dev console — can call freely; bursty
//      calls will collapse.
//
// The bridge is intentionally UI-agnostic: Phase 2 has no rendered
// elements, so the only way to exercise the GUI-write path in-app is via
// `window.__aperture.setState(key, value)` in the dev console. Phase 3
// wires this to real `<input>`-bound elements.

import { invoke as tauriInvoke } from '@tauri-apps/api/core'

type Subscriber = (value: unknown) => void

class StateBridge {
  private shadow = new Map<string, unknown>()
  private subs = new Map<string, Set<Subscriber>>()
  private pending = new Map<string, unknown>()
  private rafHandle: number | null = null

  ingestScriptSet(key: string, value: unknown) {
    this.shadow.set(key, value)
    const set = this.subs.get(key)
    if (set) for (const fn of set) fn(value)
  }

  get(key: string) {
    return this.shadow.get(key)
  }

  subscribe(key: string, handler: Subscriber) {
    let set = this.subs.get(key)
    if (!set) {
      set = new Set()
      this.subs.set(key, set)
    }
    set.add(handler)
    return () => {
      const s = this.subs.get(key)
      if (s) {
        s.delete(handler)
        if (s.size === 0) this.subs.delete(key)
      }
    }
  }

  /**
   * GUI-origin write. Each key is coalesced to ≤1 message per rAF tick —
   * rapid-fire calls keep the latest value only. Also updates the shadow
   * synchronously so local reads see the new value immediately; the script
   * side confirms on the next tick via its own `state:set` echo.
   */
  setState(key: string, value: unknown) {
    this.shadow.set(key, value)
    this.pending.set(key, value)
    const set = this.subs.get(key)
    if (set) for (const fn of set) fn(value)
    this.scheduleFlush()
  }

  private scheduleFlush() {
    if (this.rafHandle != null) return
    const raf =
      typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame
        : (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 16) as unknown as number
    this.rafHandle = raf(() => this.flush()) as unknown as number
  }

  private async flush() {
    this.rafHandle = null
    const batch = Array.from(this.pending.entries())
    this.pending.clear()
    for (const [key, value] of batch) {
      try {
        await tauriInvoke('send_to_child', {
          event: { type: 'state:changed', key, value },
        })
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[state-bridge] send_to_child failed', err)
      }
    }
  }
}

export const stateBridge = new StateBridge()

/**
 * Attach a dev-console handle so state writes can be exercised without UI
 * binding (which arrives in Phase 3). Intentionally non-enumerable so it
 * doesn't clutter the global namespace in console auto-complete.
 */
export function installDevHandle() {
  if (typeof window === 'undefined') return
  const ap = {
    setState: (key: string, value: unknown) => stateBridge.setState(key, value),
    get: (key: string) => stateBridge.get(key),
    subscribe: (key: string, fn: Subscriber) => stateBridge.subscribe(key, fn),
  }
  Object.defineProperty(window, '__aperture', {
    configurable: true,
    value: Object.freeze(ap),
  })
}
