type Formatter = (value: unknown) => string

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

const BUILTIN: Record<string, Formatter> = {
  bytes(v) {
    const n = Number(v)
    if (!isFinite(n)) return String(v)
    let i = 0
    let x = Math.abs(n)
    while (x >= 1024 && i < UNITS.length - 1) { x /= 1024; i++ }
    return `${(Math.sign(n) * x).toFixed(i === 0 ? 0 : 1)} ${UNITS[i]}`
  },
  ms(v) {
    const n = Number(v)
    if (!isFinite(n)) return String(v)
    if (n < 1000) return `${n.toFixed(0)}ms`
    if (n < 60_000) return `${(n / 1000).toFixed(1)}s`
    return `${(n / 60_000).toFixed(1)}m`
  },
  date(v) {
    try {
      return new Date(v as string).toLocaleString()
    } catch {
      return String(v)
    }
  },
  number(v) {
    const n = Number(v)
    return isFinite(n) ? n.toLocaleString() : String(v)
  },
  percent(v) {
    const n = Number(v)
    if (!isFinite(n)) return String(v)
    return `${(n * 100).toFixed(1)}%`
  },
  relative(v) {
    try {
      const ms = Date.now() - new Date(v as string).getTime()
      const abs = Math.abs(ms)
      if (abs < 60_000) return 'just now'
      if (abs < 3_600_000) return `${Math.round(abs / 60_000)}m ago`
      if (abs < 86_400_000) return `${Math.round(abs / 3_600_000)}h ago`
      return `${Math.round(abs / 86_400_000)}d ago`
    } catch {
      return String(v)
    }
  },
}

export function applyFormat(value: unknown, format: string | undefined): string {
  if (!format) return value == null ? '' : String(value)
  const fn = BUILTIN[format]
  if (fn) return fn(value)
  return value == null ? '' : String(value)
}
