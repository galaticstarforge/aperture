const TOKENS: Record<string, string> = {
  success: 'var(--ap-success)',
  danger: 'var(--ap-danger)',
  warning: 'var(--ap-warning)',
  info: 'var(--ap-info)',
  neutral: 'var(--ap-neutral)',
}

export function resolveColor(input: string | undefined): string | undefined {
  if (!input) return undefined
  return TOKENS[input] ?? input
}
