import { useRef, useEffect, useState } from 'react'
import type { StatNode } from '../types'
import { useStateValue } from '../hooks'

function useCountUp(target: number | undefined): number {
  const [display, setDisplay] = useState(target ?? 0)
  const prev = useRef(target ?? 0)
  const raf = useRef<number>(0)

  useEffect(() => {
    if (target == null) return
    const start = prev.current
    const end = target
    if (start === end) return

    const duration = 400
    const startTime = performance.now()

    const step = (now: number) => {
      const t = Math.min(1, (now - startTime) / duration)
      const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t
      setDisplay(start + (end - start) * ease)
      if (t < 1) {
        raf.current = requestAnimationFrame(step)
      } else {
        prev.current = end
      }
    }
    raf.current = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf.current)
  }, [target])

  return display
}

export function StatElement({ node }: { node: StatNode }) {
  const raw = useStateValue<number>(node.bind)
  const delta = useStateValue<number>(node.delta)
  const display = useCountUp(typeof raw === 'number' ? raw : undefined)

  const sign = typeof delta === 'number' && delta !== 0 ? (delta > 0 ? '+' : '') : null

  return (
    <div className="ap-stat">
      {node.label && <div className="ap-stat__label">{node.label}</div>}
      <div className="ap-stat__value">
        {typeof raw === 'number' ? display.toLocaleString(undefined, { maximumFractionDigits: 2 }) : (raw ?? '—')}
        {sign != null && typeof delta === 'number' && (
          <span
            className="ap-stat__delta"
            style={{ color: delta > 0 ? 'var(--ap-success)' : 'var(--ap-danger)' }}
          >
            {sign}{delta.toLocaleString()}
          </span>
        )}
      </div>
    </div>
  )
}
