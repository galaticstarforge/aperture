// Declarative UI node types — mirrors the element registry in design.md.

export type Predicate =
  | string
  | { bind: string; value?: unknown }
  | { bind: string; gt?: number; lt?: number; gte?: number; lte?: number; not?: unknown }

export type ButtonVariant = 'primary' | 'secondary' | 'danger'
export type CardVariant = 'default' | 'info' | 'danger'
export type AlertLevel = 'info' | 'warning' | 'error' | 'success'
export type ImageSrcType = 'auto' | 'path' | 'url' | 'base64'
export type FileStore = 'path' | 'meta' | 'contents'

export interface BaseNode {
  type: string
  visibleWhen?: Predicate
  disabledWhen?: Predicate
}

// --- Inputs ---

export interface InputNode extends BaseNode {
  type: 'input'
  bind?: string
  label?: string
  inputType?: 'text' | 'email' | 'password'
  placeholder?: string
  shortcut?: string
}

export interface NumberNode extends BaseNode {
  type: 'number'
  bind?: string
  label?: string
  min?: number
  max?: number
  step?: number
}

export interface TextareaNode extends BaseNode {
  type: 'textarea'
  bind?: string
  label?: string
  rows?: number
  resizable?: boolean
}

export interface SelectOption {
  value: string | number
  label: string
}

export interface SelectNode extends BaseNode {
  type: 'select'
  bind?: string
  label?: string
  options?: SelectOption[] | string[] | string
}

export interface CheckboxNode extends BaseNode {
  type: 'checkbox'
  bind?: string
  label?: string
}

export interface SliderNode extends BaseNode {
  type: 'slider'
  bind?: string
  label?: string
  min?: number
  max?: number
  step?: number
}

export interface ButtonNode extends BaseNode {
  type: 'button'
  label?: string
  onClick?: string
  variant?: ButtonVariant
  shortcut?: string
}

export interface FileNode extends BaseNode {
  type: 'file'
  bind?: string
  label?: string
  mode?: 'file' | 'directory'
  filter?: string
  store?: FileStore
}

// --- Display ---

export interface LabelNode extends BaseNode {
  type: 'label'
  bind?: string
  text?: string
  format?: string
}

export interface BadgeNode extends BaseNode {
  type: 'badge'
  bind?: string
  variants?: Record<string, string>
}

export interface ProgressNode extends BaseNode {
  type: 'progress'
  bind?: string
  indeterminate?: boolean
}

export interface CodeNode extends BaseNode {
  type: 'code'
  bind?: string
  text?: string
  language?: string
}

export interface OutputNode extends BaseNode {
  type: 'output'
  bind?: string
}

export interface StatNode extends BaseNode {
  type: 'stat'
  bind?: string
  label?: string
  delta?: string
}

export interface AlertNode extends BaseNode {
  type: 'alert'
  bind?: string
  message?: string
  level?: AlertLevel
}

export interface ImageNode extends BaseNode {
  type: 'image'
  bind?: string
  srcType?: ImageSrcType
  fit?: string
  maxHeight?: number | string
  background?: string
  onClick?: string
}

// --- Layout ---

export interface RowNode extends BaseNode {
  type: 'row'
  gap?: number
  align?: string
  justify?: string
  children?: UiNode[]
}

export interface ColumnNode extends BaseNode {
  type: 'column'
  gap?: number
  align?: string
  children?: UiNode[]
}

export interface CardAction {
  type: 'button'
  label?: string
  onClick?: string
  variant?: ButtonVariant
}

export interface CardNode extends BaseNode {
  type: 'card'
  title?: string
  padding?: number
  collapsible?: boolean
  variant?: CardVariant
  children?: UiNode[]
  footer?: UiNode[]
  actions?: CardAction[]
}

export interface TabItem {
  label: string
  children?: UiNode[]
  visibleWhen?: Predicate
  keepAlive?: boolean
}

export interface TabsNode extends BaseNode {
  type: 'tabs'
  items?: TabItem[]
}

export interface DividerNode extends BaseNode {
  type: 'divider'
  label?: string
}

export interface ScrollNode extends BaseNode {
  type: 'scroll'
  maxHeight?: number | string
  children?: UiNode[]
}

export type UiNode =
  | InputNode | NumberNode | TextareaNode | SelectNode | CheckboxNode
  | SliderNode | ButtonNode | FileNode
  | LabelNode | BadgeNode | ProgressNode | CodeNode | OutputNode
  | StatNode | AlertNode | ImageNode
  | RowNode | ColumnNode | CardNode | TabsNode | DividerNode | ScrollNode
  | (BaseNode & { [key: string]: unknown })
