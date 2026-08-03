import type { ElectronApplication } from '@playwright/test'
import type { BridgeResourceCensus } from '../src/main/ipc/bridge-router'
import { pollUntil } from './helpers'

/**
 * Resource-leak guards for e2e runs. Coarse memory sampling (RSS trend) only
 * catches catastrophic leaks; the guards here watch the two precise signals:
 *
 * - `armMaxListenersGuard` — Node prints MaxListenersExceededWarning to stderr
 *   when an emitter accumulates dead listeners (one-leaked-hook-per-cycle
 *   class). Any such line during a test is a hard failure, not log noise.
 * - `readBridgeCensus` / `settleBridgeCensus` — the bridge router's exact
 *   resource ledger (sessions / wc bindings / pending API calls / teardown
 *   hooks), exposed by the NODE_ENV=test global `__diminaResourceCensus`.
 *   Churn specs assert the ledger returns EXACTLY to baseline.
 */

export interface MaxListenersGuard {
  /** MaxListenersExceededWarning stderr lines observed so far. */
  warnings(): readonly string[]
}

/**
 * Tap the Electron child process's stderr and collect every
 * MaxListenersExceededWarning line. Arm once per launched app; reading the
 * stream does not consume it away from Playwright's own pipe handling.
 */
export function armMaxListenersGuard(electronApp: ElectronApplication): MaxListenersGuard {
  const hits: string[] = []
  let buffer = ''
  const stderr = electronApp.process().stderr
  stderr?.on('data', (chunk: Buffer | string) => {
    buffer += chunk.toString()
    for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      // Keep the decoded identity line too (main's max-listeners-diagnostic
      // resolves the tripped emitter to wcId/type/url) so a gate failure names
      // the concrete surface instead of Node's anonymous [WebContents].
      if (line.includes('MaxListenersExceededWarning') || line.includes('[max-listeners]')) hits.push(line)
    }
  })
  return { warnings: () => hits }
}

/** Read the bridge router's resource ledger from the main process. */
export async function readBridgeCensus(electronApp: ElectronApplication): Promise<BridgeResourceCensus> {
  const census = await electronApp.evaluate(() => {
    const probe = (globalThis as Record<string, unknown>).__diminaResourceCensus
    return typeof probe === 'function' ? (probe as () => unknown)() : null
  })
  if (!census) {
    throw new Error('__diminaResourceCensus probe not registered (NODE_ENV=test main process only)')
  }
  return census as BridgeResourceCensus
}

/**
 * Wait until the ledger is STABLE (two consecutive reads `intervalMs` apart are
 * identical) and satisfies `predicate`. Session teardown finishes on async
 * tails (pool release / resource-server close), so a churn step must settle
 * before exact-equality assertions.
 */
export async function settleBridgeCensus(
  electronApp: ElectronApplication,
  predicate: (census: BridgeResourceCensus) => boolean,
  timeoutMs = 10_000,
  intervalMs = 250,
): Promise<BridgeResourceCensus> {
  let previous = ''
  const final = await pollUntil(
    async () => {
      const census = await readBridgeCensus(electronApp)
      const key = JSON.stringify(census)
      const stable = key === previous && predicate(census)
      previous = key
      return { census, stable }
    },
    (result) => result.stable,
    timeoutMs,
    intervalMs,
  )
  return final.census
}
