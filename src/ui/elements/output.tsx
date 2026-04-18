import { useState } from 'react'
import type { OutputNode } from '../types'
import { useStateValue } from '../hooks'

function JsonNode({ value, depth = 0 }: { value: unknown; depth?: number }) {
  const [open, setOpen] = useState(depth < 2)

  if (value === null) return <span className="ap-json-null">null</span>
  if (typeof value === 'boolean') return <span className="ap-json-bool">{String(value)}</span>
  if (typeof value === 'number') return <span className="ap-json-num">{value}</span>
  if (typeof value === 'string') return <span className="ap-json-str">"{value}"</span>

  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="ap-json-punc">[]</span>
    return (
      <span>
        <button className="ap-json-toggle" onClick={() => setOpen((o) => !o)}>
          {open ? '▾' : '▸'}
        </button>
        {open ? (
          <span>
            {'['}
            <div style={{ paddingLeft: 16 }}>
              {value.map((v, i) => (
                <div key={i}>
                  <JsonNode value={v} depth={depth + 1} />
                  {i < value.length - 1 && <span className="ap-json-punc">,</span>}
                </div>
              ))}
            </div>
            {']'}
          </span>
        ) : (
          <span className="ap-json-punc ap-muted">[…{value.length}]</span>
        )}
      </span>
    )
  }

  if (typeof value === 'object') {
    const keys = Object.keys(value as object)
    if (keys.length === 0) return <span className="ap-json-punc">{'{}'}</span>
    return (
      <span>
        <button className="ap-json-toggle" onClick={() => setOpen((o) => !o)}>
          {open ? '▾' : '▸'}
        </button>
        {open ? (
          <span>
            {'{'}
            <div style={{ paddingLeft: 16 }}>
              {keys.map((k, i) => (
                <div key={k}>
                  <span className="ap-json-key">"{k}"</span>
                  <span className="ap-json-punc">: </span>
                  <JsonNode value={(value as Record<string, unknown>)[k]} depth={depth + 1} />
                  {i < keys.length - 1 && <span className="ap-json-punc">,</span>}
                </div>
              ))}
            </div>
            {'}'}
          </span>
        ) : (
          <span className="ap-json-punc ap-muted">&#123;…{keys.length}&#125;</span>
        )}
      </span>
    )
  }

  return <span>{String(value)}</span>
}

export function OutputElement({ node }: { node: OutputNode }) {
  const val = useStateValue(node.bind)

  return (
    <pre className="ap-output">
      <JsonNode value={val} />
    </pre>
  )
}
