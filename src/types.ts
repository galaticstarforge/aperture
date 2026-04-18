// Wire-protocol types mirrored between Rust backend and React frontend.
// Full union is declared here so later phases plug in by adding a case.

export type WindowConfig = {
  width?: number
  height?: number
  resizable?: boolean
  minWidth?: number
  minHeight?: number
  title?: string
}

export type ScriptEvent =
  | { type: 'progress';         value: number; label?: string }
  | { type: 'log';              level: 'info' | 'warn' | 'error'; message: string; data?: unknown; source?: string }
  | { type: 'state:set';        key: string; value: unknown }
  | { type: 'state:set:chunk';  key: string; chunk: string; final: boolean }
  | { type: 'state:get';        key: string; callId: string }
  | { type: 'invoke';           fn: string; args: unknown; callId: string; stream?: boolean }
  | { type: 'format:result';    callId: string; result?: unknown; error?: string }
  | { type: 'result';           data: unknown }
  | { type: 'error';            message: string; stack?: string }
  | { type: 'manifest';         ui: unknown; window: WindowConfig; callbacks: string[]; formatters: string[]; timeoutMs: number | null }
  | { type: 'ui:update';        tree: unknown }

export type GUIEvent =
  | { type: 'state:set';       key: string; value: unknown }
  | { type: 'state:changed';   key: string; value: unknown }
  | { type: 'state:get:reply'; callId: string; value: unknown }
  | { type: 'invoke:result';   callId: string; result?: unknown; error?: string }
  | { type: 'invoke:stream';   callId: string; chunk: unknown; final: boolean; error?: string }
  | { type: 'format:request';  callId: string; name: string; value: unknown; context: unknown }
  | { type: 'call';            fn: string; args: unknown; callId: string }
  | { type: 'cancel';          reason?: string }

// Internal backend→frontend messages (not ScriptEvents).
export type WindowGeometry = { width: number; height: number; x: number; y: number }

export type BackendMessage =
  | { kind: 'launch';            source: string; cwd: string; rawFlags: Record<string, string>; offline: boolean; devMode: boolean; persistedGeometry?: WindowGeometry | null }
  | { kind: 'phase';             phase: 'installing' | 'running' | 'exiting' }
  | { kind: 'script';            event: ScriptEvent }
  // A fully-reassembled state:set. The backend buffers state:set:chunk
  // frames transparently per design.md §"Streaming Opt-In" and only
  // forwards this once `final: true` lands.
  | { kind: 'state-set';         key: string; value: unknown }
  | { kind: 'stderr';            line: string }
  | { kind: 'parse-error';       line: string; error: string }
  | { kind: 'child-exit';        code: number | null; signal: string | null; stderrTail: string; logAvailable: boolean }
  | { kind: 'fatal';             message: string; stack?: string }
  | { kind: 'env-approval';      vars: string[]; cacheKey: string }
  | { kind: 'install-progress';  label: string }
  | { kind: 'protocol-event';    direction: 'inbound' | 'outbound'; event: unknown }

// Invoke confirm/prompt modal request shapes.
export type InvokeRequest =
  | { fn: 'confirm';     args: { message: string };                  callId: string }
  | { fn: 'prompt';      args: { message: string };                  callId: string }
  | { fn: 'filePicker';  args: { mode?: string; filter?: string; recursive?: boolean }; callId: string }
  | { fn: 'notification'; args: { title: string; body?: string; level?: string }; callId: string }
  | { fn: 'openExternal'; args: { url: string; newWindow?: boolean }; callId: string }
  | { fn: 'clipboard';   args: { op: 'read' | 'write'; text?: string }; callId: string }

export type ProgressState = { value: number; label?: string } | null
