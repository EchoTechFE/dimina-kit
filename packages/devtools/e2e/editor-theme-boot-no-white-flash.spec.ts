/**
 * Embedded VS Code workbench, startup theme: the workbench is a plain
 * WebContentsView (not a BrowserWindow), so the process-wide installTheme
 * background sync never reaches it. Before the fix its surface — and the
 * "booting workbench…" page before the 12 MB bundle loads — defaulted to
 * Electron's white, so the boot screen flashed white instead of matching the
 * active dark theme.
 *
 * The fix paints a themed backdrop in the workbench `index.html` itself (an
 * inline script that sets `documentElement`/`body` background to `#1a1a1a` in
 * dark or `#fafafa` in light, before the bundle loads), and the attach path
 * also calls `setBackgroundColor(themeBg())` on the WebContentsView. The
 * booting-screen white flash is the user-visible symptom, so this spec pins
 * the contract that the workbench page the runtime actually serves carries the
 * themed backdrop guard — without it the boot screen flashes white.
 */
import { test, expect } from './fixtures'
import { DEMO_APP_DIR, openProjectInUI } from './helpers'
import { attachWorkbenchAndWaitReady } from './workbench-probe'

/** The workbench `index.html` the runtime serves (found via the probe signal). */
async function workbenchIndexHtml(electronApp: import('@playwright/test').ElectronApplication): Promise<string | null> {
  return electronApp.evaluate(async ({ webContents }) => {
    const wcs = webContents.getAllWebContents().filter((w) => !w.isDestroyed())
    for (const wc of wcs) {
      try {
        // The workbench wc is the one exposing the probe status signal.
        const s = await wc.executeJavaScript(
          'typeof window.__WB_STATUS === "string" ? window.__WB_STATUS : null',
        )
        if (typeof s !== 'string') continue
        // Fetch the page the WebContentsView actually loaded and return its HTML.
        const res = await fetch(wc.getURL())
        return await res.text()
      } catch {
        // not the workbench wc, or fetch failed — try the next one
      }
    }
    return null
  }) as Promise<string | null>
}

test.describe('embedded workbench: no white flash on startup', () => {
  test.setTimeout(180_000)

  test('the served workbench page paints a themed backdrop before the bundle loads', async ({
    mainWindow,
    electronApp,
  }) => {
    await openProjectInUI(mainWindow, DEMO_APP_DIR, { waitMs: 60_000 })
    const status = await attachWorkbenchAndWaitReady(mainWindow, electronApp)
    expect(status, 'workbench must reach a ready status').toMatch(/workbench-ready|exthost-alive/)

    // Fetch the workbench page the runtime actually serves and confirm it
    // carries the themed-backdrop guard — the inline script that paints the
    // document background to the active scheme (dark #1a1a1a / light #fafafa)
    // before the bundle loads, so the boot screen never flashes white.
    const html = await workbenchIndexHtml(electronApp)
    expect(html, 'the workbench index.html must be fetchable').not.toBeNull()
    // The inline guard paints the root + body background to the themed color.
    expect(html).toContain('documentElement.style.backgroundColor')
    expect(html).toContain('document.body.style.backgroundColor')
    // Both scheme colors are present so the guard covers dark AND light.
    expect(html).toContain('#1a1a1a')
    expect(html).toContain('#fafafa')
    // The scheme is taken from the `?theme=` query attachWorkbench passes.
    expect(html).toContain('?theme=')
  })
})
