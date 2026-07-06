/**
 * Shared probes for driving the embedded VS Code workbench WebContentsView
 * from e2e specs (wal-audit.spec.ts, disk-sync.spec.ts): find the workbench wc
 * by polling for `window.__WB_STATUS`, then `executeJavaScript` against it.
 *
 * Hardened against a sibling webContents stuck mid-load (hot-reload DeviceShell
 * respawns leave one around while we probe):
 *  - skip `isLoading()` webContents — `executeJavaScript` on a loading wc
 *    queues a did-stop-loading waiter and can hang the whole outer
 *    `app.evaluate` indefinitely (same guard as helpers.waitSimulatorReady);
 *  - race every probe/eval with a timeout so one stuck wc costs a poll
 *    iteration, not the entire test timeout.
 */
import type { Page, ElectronApplication } from '@playwright/test'
import { pollUntil, ipcInvoke } from './helpers'
import { ViewChannel } from '../src/shared/ipc-channels'

/** Run `expr` inside the embedded workbench's WebContentsView. */
export async function runInWorkbench<T>(app: ElectronApplication, expr: string): Promise<T> {
  return app.evaluate(async ({ webContents }, e) => {
    const withTimeout = <V>(p: Promise<V>, ms: number): Promise<V> =>
      Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('wc probe timeout')), ms))])
    const wcs = webContents.getAllWebContents().filter((wc) => !wc.isDestroyed() && !wc.isLoading())
    for (const wc of wcs) {
      try {
        const s = await withTimeout(
          wc.executeJavaScript('typeof window.__WB_STATUS === "string" ? window.__WB_STATUS : null'),
          3000,
        )
        if (typeof s === 'string') return withTimeout(wc.executeJavaScript(e), 30_000)
      } catch {
        // not the workbench wc (or not yet probeable) — try the next one
      }
    }
    throw new Error('workbench webContents not found')
  }, expr) as Promise<T>
}

/** The workbench's `window.__WB_STATUS`, or `null` when no workbench wc is probeable yet. */
export async function workbenchStatus(app: ElectronApplication): Promise<string | null> {
  return runInWorkbench<string>(app, 'window.__WB_STATUS').catch(() => null)
}

/**
 * Force the lazily-attached workbench WCV to load (best-effort — the natural
 * dock-slot-visible attach path also works without it), then wait for a ready
 * status. Returns the status so a spec can assert on it.
 */
export async function attachWorkbenchAndWaitReady(
  mainWindow: Page,
  electronApp: ElectronApplication,
  timeoutMs = 90_000,
): Promise<string | null> {
  await ipcInvoke(mainWindow, ViewChannel.WorkbenchBounds, { x: 0, y: 0, width: 900, height: 700 }).catch(() => {})
  return pollUntil(
    () => workbenchStatus(electronApp),
    (s) => s === 'workbench-ready' || s === 'exthost-alive',
    timeoutMs,
    500,
  )
}
