import type { AlertNode } from '../types'
import { useStateValue } from '../hooks'

const LEVEL_COLORS: Record<string, string> = {
  info: 'var(--ap-info)',
  warning: 'var(--ap-warning)',
  error: 'var(--ap-danger)',
  success: 'var(--ap-success)',
}

export function AlertElement({ node }: { node: AlertNode }) {
  const val = useStateValue<string>(node.bind)
  const message = node.bind != null ? val : node.message
  if (!message) return null

  const color = LEVEL_COLORS[node.level ?? 'info'] ?? LEVEL_COLORS.info

  return (
    <div
      className="ap-alert"
      style={{ borderLeftColor: color }}
    >
      <span style={{ color }}>{String(message)}</span>
    </div>
  )
}
