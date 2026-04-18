import { useCallback, useRef } from 'react'
import type { FileNode } from '../types'
import { useStateValue, usePredicate } from '../hooks'
import { stateBridge } from '../../state-bridge'

export function FileElement({ node }: { node: FileNode }) {
  const current = useStateValue<string>(node.bind)
  const disabled = usePredicate(node.disabledWhen, false)
  const inputRef = useRef<HTMLInputElement>(null)

  const onFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      if (!node.bind) return
      const file = e.target.files?.[0]
      if (!file) return

      const store = node.store ?? 'path'
      if (store === 'meta') {
        stateBridge.setState(node.bind, {
          name: file.name,
          size: file.size,
          type: file.type,
          // Full path unavailable in WebView without dialog plugin — Phase 4 upgrades this.
          path: file.name,
        })
      } else if (store === 'contents') {
        const text = await file.text()
        stateBridge.setState(node.bind, text)
      } else {
        // 'path' — best effort: return the filename (full path requires dialog plugin in Phase 4)
        stateBridge.setState(node.bind, file.name)
      }
    },
    [node.bind, node.store],
  )

  return (
    <div className="ap-field">
      {node.label && <label className="ap-field-label">{node.label}</label>}
      <div className="ap-file-wrap">
        <button
          className="secondary"
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
        >
          Choose {node.mode === 'directory' ? 'Folder' : 'File'}
        </button>
        {current && (
          <span className="ap-file-name ap-muted" style={{ fontSize: 12 }}>
            {String(current)}
          </span>
        )}
        <input
          ref={inputRef}
          type="file"
          style={{ display: 'none' }}
          accept={node.filter}
          onChange={onFileChange}
          {...(node.mode === 'directory' ? { webkitdirectory: '' } : {})}
        />
      </div>
    </div>
  )
}
