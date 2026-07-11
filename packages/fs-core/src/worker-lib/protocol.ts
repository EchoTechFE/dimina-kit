/**
 * fs-core wire contract — the single authoritative enumeration of the error
 * codes, event names, mode values, and message shapes that cross the worker
 * boundary. Both ends compile against this module (worker side:
 * engine-shared.ts's `rpcErr` signature; main-thread side: client.ts), and
 * consumers should match on these exported symbols instead of quoting string
 * literals from worker source or citing dist line numbers — those references
 * rot on every version bump while the wire strings silently stay load-bearing.
 *
 * Lib-neutral (types + pure predicates only) so it stays compilable by both
 * the DOM and the WebWorker tsc programs — see this directory's convention in
 * ../../tsconfig.json.
 */

/**
 * Single-writer lifecycle of one fs-core worker, as observed by a client:
 * starting (HELLO sent, WELCOME not yet received) | writer (holds the Web
 * Locks writer lease) | readonly (queued for the lease, or handed it over) |
 * draining (worker-side handover transient — a client never observes it for
 * long; see fs-core-recovery.ts, which converges to readonly before
 * broadcasting) | dead (FATAL received, the worker is unusable).
 */
export type FsCoreMode = 'starting' | 'writer' | 'readonly' | 'draining' | 'dead'

/**
 * Every `code` a rejected fs-core RPC can carry (client-side: `error.code` on
 * the rejection; wire-side: the `code` field of a `{ok: false}` reply). The
 * worker's `rpcErr` factory is typed against this list, so a code appearing
 * here and a code the worker can actually throw are the same set by
 * construction.
 */
export const FS_CORE_ERROR_CODES = [
  /** Write attempted while this worker does not hold the writer lease (another tab owns it). */
  'readonly',
  /** Write attempted while the writer lease handover is in progress. */
  'draining',
  /** Agent write without an active matching turn, or the turn has expired. */
  'turn-closed',
  /** `turnBegin` while another turn is already active. */
  'turn-active',
  /** Per-turn op quota exceeded. */
  'turn-quota',
  /** Agent write without the armed agent token (see `armAgentTokenGate`). */
  'agent-token-required',
  /** `armAgentTokenGate` re-armed with a DIFFERENT token (same token replays are ok+idempotent). */
  'agent-token-gate-armed',
  /** `restore` refused: the audit window no longer covers `baseGen`, or human edits landed since (carries `humanPaths`/`auditGap` extras). */
  'restore-conflict',
  /** Optimistic-concurrency failure: `ifMatch` mismatch, or the target path already exists. */
  'cas-mismatch',
  /** `edit`'s old string not found in the file. */
  'edit-no-match',
  /** `edit`'s old string matches more than once. */
  'edit-ambiguous',
  /** Path (or checkpoint id) does not exist. */
  'not-found',
  /** Path failed normalization (absolute, `..`, empty, ...). */
  'bad-path',
  /** Malformed argument (non-string content, missing turnId, ...). */
  'bad-args',
  /** Unknown RPC op name. */
  'bad-op',
  /** Write into a derived (read-only) area. */
  'derived-readonly',
  /** Internal write-path signal (WAL segment rotation needed); not expected to surface to clients. */
  'rotate-needed',
  /** Fallback for a worker-side error that carried no code of its own. */
  'internal',
] as const

export type FsCoreErrorCode = (typeof FS_CORE_ERROR_CODES)[number]

/** Extra fields a `restore-conflict` rejection carries (see `rpcErr`'s `extra`). */
export interface FsCoreErrorExtras {
  humanPaths?: string[]
  auditGap?: boolean
}

/**
 * `error.code` of `error` when it looks like an fs-core RPC rejection,
 * else `undefined`. Purely structural — works on the plain `Error` the client
 * materializes as well as on a structured-clone of it.
 */
export function getFsCoreErrorCode(error: unknown): FsCoreErrorCode | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined
  const code = (error as { code?: unknown }).code
  return (FS_CORE_ERROR_CODES as readonly unknown[]).includes(code) ? (code as FsCoreErrorCode) : undefined
}

/** True when `error` is an fs-core RPC rejection carrying exactly `code`. */
export function isFsCoreErrorCode(error: unknown, code: FsCoreErrorCode): boolean {
  return getFsCoreErrorCode(error) === code
}

/** Names of the unsolicited events the core worker pushes to its client. */
export type FsCoreEventName = 'writer-granted' | 'writer-lost' | 'fs-change'

// ── Wire message shapes (worker → client main port) ──

/** First message after HELLO; resolves `ProjectFsClient.connect`. */
export interface CoreWelcomeMessage {
  type: 'WELCOME'
  epoch: number
  memGen: number
  readonly: boolean
  mode: FsCoreMode
}

/** Unrecoverable worker failure — the worker is unusable afterwards. */
export interface CoreFatalMessage {
  type: 'FATAL'
  error: string
}

/** Liveness reply to the client's PING. */
export interface CorePongMessage {
  type: 'PONG'
  t?: number
}

/**
 * Unsolicited event push. `writer-granted`/`writer-lost` drive the client's
 * `mode`; `fs-change` reports a committed write batch (`paths` when ≤ 32,
 * else just `count`; `restore` carries the checkpoint id a restore replayed).
 */
export interface CoreEventMessage {
  evt: FsCoreEventName
  gen?: number
  actor?: string
  paths?: string[]
  count?: number
  restore?: string
}

/** RPC reply, success. */
export interface CoreReplyOkMessage {
  id: number
  ok: true
  result: unknown
}

/** RPC reply, failure — `code` is one of {@link FS_CORE_ERROR_CODES}. */
export interface CoreReplyErrMessage extends FsCoreErrorExtras {
  id: number
  ok: false
  code: FsCoreErrorCode
  error: string
}

/** Everything the core worker's main port can deliver, as a discriminated union. */
export type CoreWireMessage =
  | CoreWelcomeMessage
  | CoreFatalMessage
  | CorePongMessage
  | CoreEventMessage
  | CoreReplyOkMessage
  | CoreReplyErrMessage

/**
 * Loosely-shaped dynamic view of {@link CoreWireMessage}: every field
 * optional, distinguished at runtime by which ones are present. This matches
 * how `ProjectFsClient` actually reads the port (each field independently
 * checked), and is the type its `onChange` callbacks receive; the union above
 * is the authoritative shape each individual message satisfies.
 */
export interface CoreMessage {
  type?: string
  evt?: string
  error?: string
  mode?: FsCoreMode
  readonly?: boolean
  gen?: number
  id?: number
  ok?: boolean
  result?: unknown
  code?: string
  humanPaths?: string[]
  auditGap?: boolean
  actor?: string
  paths?: string[]
  count?: number
  restore?: string
  t?: number
}
