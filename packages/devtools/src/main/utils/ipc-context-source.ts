import type { WebContents } from 'electron'
import type { SenderPolicy } from './ipc-registry.js'

/**
 * Resolves which window context owns an incoming IPC sender.
 *
 * `register*Ipc` takes one of these instead of a bare context so a single
 * handler body serves both shapes: one window (every accepted sender maps to
 * that window's context) and several windows (each message is answered by the
 * context of the window it actually came from).
 */
export interface IpcContextSource<T> {
  /**
   * Set only by the adapter over a context that carries no `senderPolicy` —
   * narrow test contexts. It keeps {@link IpcRegistry} in its policy-less mode
   * (accept every sender, skip the main-frame check), so wrapping such a
   * context in a source is not itself a trust change.
   */
  readonly ungated?: boolean
  /** The context owning `sender`, or null when no context claims it. */
  resolve(sender: WebContents): T | null
  /** Every context this source can hand out. */
  list(): T[]
}

/**
 * What every `register*Ipc` accepts: a router covering all live windows, or a
 * single context standing in for itself.
 */
export type IpcInput<T> = T | IpcContextSource<T>

/** Structural test: a source exposes both members, a context exposes neither. */
export function isIpcContextSource<T>(value: unknown): value is IpcContextSource<T> {
  if (value == null || typeof value !== 'object') return false
  const candidate = value as Partial<IpcContextSource<T>>
  return typeof candidate.resolve === 'function' && typeof candidate.list === 'function'
}

/**
 * Accept either a source or a single context. A single context gates on its
 * own `senderPolicy` — the same predicate a policy-only registry applies — and
 * owns every sender that predicate accepts. A context without a policy stays
 * ungated so narrow test contexts keep the behaviour a bare registry gave them.
 */
export function toIpcContextSource<T extends { senderPolicy?: SenderPolicy }>(
  input: T | IpcContextSource<T>,
): IpcContextSource<T> {
  if (isIpcContextSource<T>(input)) return input
  const ctx = input as T
  const policy = ctx.senderPolicy
  if (!policy) return { ungated: true, resolve: () => ctx, list: () => [ctx] }
  return { resolve: (sender) => (policy(sender) ? ctx : null), list: () => [ctx] }
}
