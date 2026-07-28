/**
 * Authoritative, queryable record of the active project's compile status in
 * the main process.
 *
 * `notify.projectStatus` is a fire-and-forget push to the renderer; MCP
 * clients instead need to QUERY the latest state and AWAIT the next settled
 * state. The notifier tap (see `status-tap.ts`) records every payload here
 * BEFORE it is broadcast — the store is the authority, the renderer push is
 * derived from the same single gate.
 *
 * "Settled" means the compile pipeline is not mid-flight: every phase except
 * `'compiling'`. `generation` is a monotonic per-record counter so a waiter
 * can ignore states recorded before its own trigger (e.g. `project_open`
 * must not accept the PREVIOUS session's `'ready'` as its own result).
 */

export type SessionPhase = 'idle' | 'compiling' | 'ready' | 'error'

export interface SessionStatusSnapshot {
  phase: SessionPhase
  message: string
  /** False once the file watcher died mid-session (saves no longer trigger a rebuild). Reset when the next compile starts. */
  watcherAlive: boolean
  /** Wall-clock time of the last recorded transition; 0 before the first one. */
  updatedAt: number
  /** Monotonic counter bumped on every record. */
  generation: number
}

export interface SessionStatusStore {
  get(): SessionStatusSnapshot
  /** Record one `projectStatus` payload (the notifier tap is the only expected caller). */
  record(payload: { status: string; message: string; watcher?: 'dead' }): void
  /**
   * Resolve with the first snapshot whose phase is settled (not 'compiling')
   * AND whose generation is greater than `afterGeneration` (default: accept
   * the current snapshot when it is already settled). Rejects after
   * `timeoutMs` with the last observed phase in the message.
   */
  waitForSettled(opts: {
    afterGeneration?: number
    timeoutMs: number
  }): Promise<SessionStatusSnapshot>
}

function toPhase(status: string): SessionPhase {
  if (status === 'compiling') return 'compiling'
  if (status === 'error') return 'error'
  // 'ready' plus any future non-error chatter: the pipeline is not mid-flight.
  return 'ready'
}

export function createSessionStatusStore(): SessionStatusStore {
  let snapshot: SessionStatusSnapshot = {
    phase: 'idle',
    message: '',
    watcherAlive: true,
    updatedAt: 0,
    generation: 0,
  }
  const waiters = new Set<(s: SessionStatusSnapshot) => void>()

  return {
    get: () => snapshot,

    record(payload) {
      const phase = toPhase(payload.status)
      snapshot = {
        phase,
        message: payload.message,
        // A dead watcher is a session-lifetime fact; only a NEW compile
        // (fresh open) resets it. Rebuild 'ready' chatter keeps it dead.
        watcherAlive: payload.watcher === 'dead'
          ? false
          : phase === 'compiling' ? true : snapshot.watcherAlive,
        updatedAt: Date.now(),
        generation: snapshot.generation + 1,
      }
      for (const waiter of [...waiters]) waiter(snapshot)
    },

    waitForSettled({ afterGeneration = -1, timeoutMs }) {
      const isSettled = (s: SessionStatusSnapshot) =>
        s.phase !== 'compiling' && s.generation > afterGeneration
      if (isSettled(snapshot)) return Promise.resolve(snapshot)
      return new Promise<SessionStatusSnapshot>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(onRecord)
          reject(new Error(
            `timed out after ${timeoutMs}ms waiting for the compile to settle `
            + `(last phase: ${snapshot.phase})`,
          ))
        }, timeoutMs)
        const onRecord = (s: SessionStatusSnapshot) => {
          if (!isSettled(s)) return
          clearTimeout(timer)
          waiters.delete(onRecord)
          resolve(s)
        }
        waiters.add(onRecord)
      })
    },
  }
}
