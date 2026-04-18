import { useCallback, useEffect, useRef, useState } from 'react'

export type ModalRequest =
  | { kind: 'confirm'; message: string; callId: string }
  | { kind: 'prompt';  message: string; callId: string }

interface Props {
  request: ModalRequest | null
  onConfirm: (callId: string, value?: string) => void
  onCancel:  (callId: string) => void
}

export function InvokeModal({ request, onConfirm, onCancel }: Props) {
  const [promptValue, setPromptValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (request) {
      setPromptValue('')
      // Focus on next frame so the modal has mounted.
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [request])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!request) return
      if (e.key === 'Enter') {
        e.preventDefault()
        if (request.kind === 'confirm') {
          onConfirm(request.callId)
        } else {
          onConfirm(request.callId, promptValue)
        }
      } else if (e.key === 'Escape') {
        e.preventDefault()
        onCancel(request.callId)
      }
    },
    [request, promptValue, onConfirm, onCancel],
  )

  if (!request) return null

  return (
    <div className="ap-modal-backdrop" onKeyDown={handleKeyDown}>
      <div className="ap-modal" role="dialog" aria-modal="true">
        <p className="ap-modal__message">{request.message}</p>

        {request.kind === 'prompt' && (
          <input
            ref={inputRef}
            className="ap-modal__input"
            type="text"
            value={promptValue}
            onChange={(e) => setPromptValue(e.target.value)}
            placeholder="Enter value…"
          />
        )}

        <div className="ap-modal__actions">
          <button
            className="primary"
            onClick={() =>
              request.kind === 'confirm'
                ? onConfirm(request.callId)
                : onConfirm(request.callId, promptValue)
            }
          >
            OK
          </button>
          <button className="secondary" onClick={() => onCancel(request.callId)}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
