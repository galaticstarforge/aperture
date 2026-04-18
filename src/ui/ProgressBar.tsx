import { useEffect, useRef, useState } from 'react'
import type { ProgressState } from '../types'

interface Props {
  progress: ProgressState
}

export function ProgressBar({ progress }: Props) {
  const [visible, setVisible] = useState(false)
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (fadeTimer.current) {
      clearTimeout(fadeTimer.current)
      fadeTimer.current = null
    }
    if (progress !== null) {
      setVisible(true)
      if (progress.value >= 1) {
        fadeTimer.current = setTimeout(() => setVisible(false), 800)
      }
    } else {
      setVisible(false)
    }
    return () => {
      if (fadeTimer.current) clearTimeout(fadeTimer.current)
    }
  }, [progress])

  if (!visible || progress === null) return null

  return (
    <div className="ap-progress-bar-wrap">
      <div
        className="ap-progress-bar-fill"
        style={{ width: `${Math.min(100, Math.max(0, progress.value * 100))}%` }}
      />
      {progress.label && (
        <span className="ap-progress-bar-label">{progress.label}</span>
      )}
    </div>
  )
}
