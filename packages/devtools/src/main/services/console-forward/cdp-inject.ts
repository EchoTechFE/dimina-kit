import type { WebContents } from 'electron'
import type { CdpSessionBroker } from '../cdp-session/index.js'

/**
 * Shared CDP injection primitive for the global mirrors (console +
 * diagnostics): evaluate `script` in `target`'s realm over the broker's
 * debugger session — never `target.executeJavaScript`, whose internal RPC
 * hangs forever on a wc that is simultaneously the inspected side of
 * `setDevToolsWebContents` AND attached by an external CDP client (see
 * global-console-mirror.ts for the full mechanism and the real-machine
 * repro).
 *
 * Resolves true only on a clean evaluation. `exceptionDetails`, a rejected
 * send, and an unacquirable session (destroyed wc / debugger exclusively
 * held elsewhere) all report false — createOpenGatedRelay then leaves the
 * entry retryable instead of marking it done.
 */
export function injectViaCdp(
  broker: CdpSessionBroker,
  target: WebContents,
  script: string,
  warnTag: string,
): boolean | Promise<boolean> {
  const lease = broker.acquire(target)
  if (!lease) return false
  return lease.send('Runtime.evaluate', { expression: script }).then(
    (result) => {
      if ((result as { exceptionDetails?: unknown } | null | undefined)?.exceptionDetails) {
        console.warn(`[${warnTag}] Runtime.evaluate reported an exception, will retry on next reopen`)
        return false
      }
      return true
    },
    (err) => {
      console.warn(`[${warnTag}] injection failed, will retry on next reopen:`, err instanceof Error ? err.message : String(err))
      return false
    },
  )
}
