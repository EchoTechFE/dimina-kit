import type { WorkbenchContext } from '../workbench-context.js'

// ── Types ─────────────────────────────────────────────────────────────

export interface RpcRequest {
  id: string
  method: string
  params: Record<string, unknown>
}

export interface RpcResponse {
  id: string
  result?: unknown
  error?: { message: string }
}

export interface RpcEvent {
  method: string
  params: unknown
}

export interface ElementRef {
  selector: string
  index: number
  pageId: number
}

export type Handler = (ctx: WorkbenchContext, params: Record<string, unknown>) => Promise<unknown>
