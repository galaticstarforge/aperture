import type { CodeNode } from '../types'
import { useStateValue } from '../hooks'

export function CodeElement({ node }: { node: CodeNode }) {
  const val = useStateValue<string>(node.bind)
  const text = node.bind != null ? val : node.text

  return (
    <pre className="ap-code">
      <code className={node.language ? `language-${node.language}` : undefined}>
        {text == null ? '' : String(text)}
      </code>
    </pre>
  )
}
