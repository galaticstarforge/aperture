import type { UiNode } from './types'
import { usePredicate } from './hooks'

// Lazy element registry — imported here so Element.tsx is the single
// place that knows about all element types.
import { InputElement } from './elements/input'
import { NumberElement } from './elements/number'
import { TextareaElement } from './elements/textarea'
import { SelectElement } from './elements/select'
import { CheckboxElement } from './elements/checkbox'
import { SliderElement } from './elements/slider'
import { ButtonElement } from './elements/button'
import { FileElement } from './elements/file'
import { LabelElement } from './elements/label'
import { BadgeElement } from './elements/badge'
import { ProgressElement } from './elements/progress'
import { CodeElement } from './elements/code'
import { OutputElement } from './elements/output'
import { StatElement } from './elements/stat'
import { AlertElement } from './elements/alert'
import { ImageElement } from './elements/image'
import { RowElement } from './elements/row'
import { ColumnElement } from './elements/column'
import { CardElement } from './elements/card'
import { TabsElement } from './elements/tabs'
import { DividerElement } from './elements/divider'
import { ScrollElement } from './elements/scroll'
import { TableElement } from './elements/table'
import { TreeElement } from './elements/tree'
import { ChartElement } from './elements/chart'
import { TimelineElement } from './elements/timeline'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const REGISTRY: Record<string, React.ComponentType<{ node: any }>> = {
  input: InputElement,
  number: NumberElement,
  textarea: TextareaElement,
  select: SelectElement,
  checkbox: CheckboxElement,
  slider: SliderElement,
  button: ButtonElement,
  file: FileElement,
  label: LabelElement,
  badge: BadgeElement,
  progress: ProgressElement,
  code: CodeElement,
  output: OutputElement,
  stat: StatElement,
  alert: AlertElement,
  image: ImageElement,
  row: RowElement,
  column: ColumnElement,
  card: CardElement,
  tabs: TabsElement,
  divider: DividerElement,
  scroll: ScrollElement,
  table: TableElement,
  tree: TreeElement,
  chart: ChartElement,
  timeline: TimelineElement,
}

export function Element({ node }: { node: UiNode }) {
  // visibleWhen is evaluated here so layout elements also benefit.
  const visible = usePredicate((node as { visibleWhen?: unknown }).visibleWhen as Parameters<typeof usePredicate>[0])

  if (!visible) return null

  const type = (node as { type?: string }).type ?? ''
  const Comp = REGISTRY[type]

  if (!Comp) return null

  return <Comp node={node} />
}
