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
  | { type: 'progress';        value: number; label?: string }
  | { type: 'log';             level: 'info' | 'warn' | 'error'; message: string; data?: unknown; source?: string }
  | { type: 'state:set';       key: string; value: unknown }
  | { type: 'state:set:chunk'; key: string; chunk: string; final: boolean }
  | { type: 'state:get';       key: string; callId: string }
  | { type: 'invoke';          fn: string; args: unknown; callId: string; stream?: boolean }
  | { type: 'result';          data: unknown }
  | { type: 'error';           message: string; stack?: string }
  | { type: 'manifest';        ui: unknown; window: WindowConfig; callbacks: string[] }
  | { type: 'ui:update';       tree: unknown }

export type GUIEvent =
  | { type: 'state:set';       key: string; value: unknown }
  | { type: 'state:changed';   key: string; value: unknown }
  | { type: 'state:get:reply'; callId: string; value: unknown }
  | { type: 'invoke:result';   callId: string; result: unknown }
  | { type: 'invoke:stream';   callId: string; chunk: unknown; final: boolean }
  | { type: 'call';            fn: string; args: unknown; callId: string }
  | { type: 'cancel';          reason?: string }

// Internal backend→frontend messages (not ScriptEvents).
export type BackendMessage =
  | { kind: 'launch';      source: string; cwd: string; rawFlags: Record<string, string>; offline: boolean }
  | { kind: 'phase';       phase: 'installing' | 'running' | 'exiting' }
  | { kind: 'script';      event: ScriptEvent }
  // A fully-reassembled state:set. The backend buffers state:set:chunk
  // frames transparently per design.md §"Streaming Opt-In" and only
  // forwards this once `final: true` lands.
  | { kind: 'state-set';   key: string; value: unknown }
  | { kind: 'stderr';      line: string }
  | { kind: 'parse-error'; line: string; error: string }
  | { kind: 'child-exit';  code: number | null; signal: string | null; stderrTail: string }
  | { kind: 'fatal';       message: string; stack?: string }
