/** Per-op RPC argument shapes (lib-neutral type aliases only) —— handleRpc's
 * dispatch table narrows the incoming `Record<string, unknown>` bag to one of
 * these via a single `as` per op, matching each op method's own destructured
 * parameter type below. */
export interface WriteArgs {
  path: string
  content: unknown
  ifMatch?: number | null
  actor?: string
  turnId?: string
  agentToken?: string
  opId?: string
}
export interface EditArgs {
  path: string
  old: string
  next: string
  ifMatch?: number
  actor?: string
  turnId?: string
  agentToken?: string
  opId?: string
}
export interface RmArgs {
  path: string
  actor?: string
  turnId?: string
  agentToken?: string
  opId?: string
}
export interface MvArgs {
  from: string
  to: string
  actor?: string
  turnId?: string
  agentToken?: string
  opId?: string
}
export interface CheckpointArgs {
  actor?: string
  turnId?: string
  agentToken?: string
  opId?: string
}
export interface RestoreArgs {
  cpId: string
  baseGen?: number
  force?: boolean
  actor?: string
  turnId?: string
  agentToken?: string
  opId?: string
}
export interface TurnBeginArgs {
  turnId: string
  ttlMs?: number
  opId?: string
}
export interface TurnEndArgs {
  turnId: string
}
export interface ReadArgs {
  path: string
}
export interface DiffArgs {
  turnId?: string
}
