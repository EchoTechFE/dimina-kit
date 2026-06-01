/**
 * Bounded retry for the cold-start race in the project file system.
 *
 * When a project is freshly opened, the main process has a brief window
 * where `ctx.workspace.getProjectPath()` still returns '' — every
 * `project:fs:*` call throws `ENOACTIVE` (see `main/ipc/project-fs.ts`).
 * The file-list load already rides out that window by retrying
 * `listProjectFiles`; the auto-open-entry-file path needs the same
 * treatment for `readFile`, otherwise the editor can render blank until
 * the user clicks a file manually.
 *
 * Only *transient* failures are retried. Real errors (`ENOENT`,
 * `EACCES`, `EINVAL`) are surfaced immediately so a manual file click on
 * a missing/forbidden path fails fast instead of stalling for seconds.
 */

/** Errors worth retrying — the active project just isn't registered yet. */
const TRANSIENT_CODES: ReadonlySet<string> = new Set(['ENOACTIVE'])

/**
 * Is `err` a transient cold-start failure (active project not yet set)?
 *
 * Prefers the structured Node `code`, but `invokeStrict` reconstructs the
 * rejection from the main process and the `code` can be lost across the
 * IPC boundary — so we also sniff the `ENOACTIVE` message text as a
 * fallback. Non-transient errors (`ENOENT`/`EACCES`/`EINVAL`) return
 * false and must NOT be retried.
 */
export function isTransientFsError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const code = (err as Error & { code?: unknown }).code
  if (typeof code === 'string') return TRANSIENT_CODES.has(code)
  // No structured code survived IPC — fall back to the message text.
  return /\bENOACTIVE\b/.test(err.message) || /\bNo active project\b/i.test(err.message)
}

export interface ReadWithRetryOptions {
  /** Total attempts (inclusive of the first). Aligns with listFiles' 12. */
  attempts: number
  /** Delay between attempts, ms. Aligns with listFiles' 300. */
  delayMs: number
  /**
   * Abort signal — checked before every attempt and after every sleep.
   * Returning true makes `readWithRetry` resolve `undefined` without
   * touching `read` again (used to honour `openSeqRef`/root changes).
   */
  isCancelled: () => boolean
  /** Injectable sleep (tests pass a no-op / flag-flipping stub). */
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms))

/**
 * Run `read` with bounded retry on transient errors.
 *
 * - Resolves with the value on the first success (no sleep on success).
 * - Resolves `undefined` if cancelled before / between attempts.
 * - Rethrows immediately on a non-transient error.
 * - Rethrows the last transient error once `attempts` is exhausted.
 */
export async function readWithRetry<T>(
  read: () => Promise<T>,
  opts: ReadWithRetryOptions,
): Promise<T | undefined> {
  const sleep = opts.sleep ?? defaultSleep
  let lastErr: unknown
  for (let i = 0; i < opts.attempts; i++) {
    if (opts.isCancelled()) return undefined
    try {
      return await read()
    } catch (err) {
      if (!isTransientFsError(err)) throw err
      lastErr = err
      // No point sleeping after the final attempt.
      if (i === opts.attempts - 1) break
      await sleep(opts.delayMs)
      if (opts.isCancelled()) return undefined
    }
  }
  throw lastErr
}
