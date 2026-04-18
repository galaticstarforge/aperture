import { useCallback } from 'react'
import type { ImageNode } from '../types'
import { useStateValue } from '../hooks'
import { useCwd } from '../cwd'
import { useDispatch } from '../dispatch'

function resolveSrc(value: string | null | undefined, srcType: string, cwd: string): string {
  if (!value) return ''
  const effective =
    srcType === 'auto'
      ? value.startsWith('data:')
        ? 'base64'
        : value.startsWith('http://') || value.startsWith('https://')
          ? 'url'
          : 'path'
      : srcType

  if (effective === 'base64' || effective === 'url') return value
  // path — resolve relative to cwd (best-effort; Tauri WebView may restrict)
  if (value.startsWith('/')) return `asset://${value}`
  return cwd ? `asset://${cwd}/${value}` : value
}

export function ImageElement({ node }: { node: ImageNode }) {
  const val = useStateValue<string>(node.bind)
  const cwd = useCwd()
  const dispatch = useDispatch()

  const src = resolveSrc(val ?? undefined, node.srcType ?? 'auto', cwd)

  const handleClick = useCallback(() => {
    if (node.onClick) void dispatch(node.onClick)
  }, [dispatch, node.onClick])

  if (!src) return <div className="ap-image ap-image--empty" />

  return (
    <img
      className="ap-image"
      src={src}
      alt=""
      onClick={node.onClick ? handleClick : undefined}
      style={{
        objectFit: (node.fit as React.CSSProperties['objectFit']) ?? 'contain',
        maxHeight: node.maxHeight,
        background: node.background,
        cursor: node.onClick ? 'pointer' : undefined,
        display: 'block',
        maxWidth: '100%',
      }}
    />
  )
}
