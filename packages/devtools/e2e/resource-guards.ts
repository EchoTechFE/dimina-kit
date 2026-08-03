import type { ElectronApplication } from '@playwright/test'

/**
 * Resource-leak guard for e2e runs: `armMaxListenersGuard` — Node prints
 * MaxListenersExceededWarning to stderr when an emitter accumulates dead
 * listeners (one-leaked-hook-per-cycle class). Any such line during a test is
 * a hard failure, not log noise.
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
