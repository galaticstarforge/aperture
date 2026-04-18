import { createContext, useContext, useEffect, useRef, ReactNode } from 'react'

type Handler = () => void
type Registry = Map<string, Handler>

const ShortcutCtx = createContext<Registry>(new Map())

export function ShortcutProvider({ children }: { children: ReactNode }) {
  const registry = useRef<Registry>(new Map()).current

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Skip when typing in an input/textarea unless it's the global Cmd+R
      const target = e.target as HTMLElement
      const inInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT'

      const combo = normalizeEvent(e)
      const handler = registry.get(combo)
      if (handler && (!inInput || e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        handler()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [registry])

  return <ShortcutCtx.Provider value={registry}>{children}</ShortcutCtx.Provider>
}

export function useShortcut(combo: string | undefined, handler: Handler): void {
  const registry = useContext(ShortcutCtx)
  useEffect(() => {
    if (!combo) return
    const key = normalizeString(combo)
    registry.set(key, handler)
    return () => { registry.delete(key) }
  }, [combo, handler, registry])
}

function normalizeEvent(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.metaKey || e.ctrlKey) parts.push('mod')
  if (e.altKey) parts.push('alt')
  if (e.shiftKey) parts.push('shift')
  parts.push(e.key.toLowerCase())
  return parts.join('+')
}

export function normalizeString(combo: string): string {
  return combo
    .toLowerCase()
    .replace(/\bcmd\b/g, 'mod')
    .replace(/\bctrl\b/g, 'mod')
    .split('+')
    .map((s) => s.trim())
    .join('+')
}
