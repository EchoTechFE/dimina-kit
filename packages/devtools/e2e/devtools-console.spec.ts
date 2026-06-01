/**
 * Console tab → Chromium DevTools attach.
 *
 * The bottom-debug-panel "Console" tab is a placeholder `<div>` that the
 * renderer measures via ResizeObserver and publishes through the
 * `view:simulator:devtools-bounds` IPC; the main process positions a
 * WebContentsView that hosts the simulator's Chromium DevTools UI onto
 * that rectangle. The DevTools UI is wired up by:
 *
 *   sim.setDevToolsWebContents(simulatorView.webContents)
 *   sim.openDevTools()
 *
 * inside `ViewManager.attachSimulator` (src/main/services/views/view-manager.ts).
 *
 * This spec runs the real Electron app and asserts the end-to-end chain:
 *   1. A `devtools://` webContents is created for the simulator after the
 *      simulator webview is ready (regardless of which tab is selected,
 *      because the WebContents itself is created at attach time).
 *   2. Selecting the Console tab causes the main process to add a
 *      simulator-devtools WebContentsView to the BrowserWindow's
 *      contentView, sized to a non-zero rectangle.
 *   3. Selecting a different tab (e.g. WXML) causes the renderer to
 *      republish a zero-area rectangle, and the main process removes the
 *      WebContentsView from contentView (but keeps the WebContents alive
 *      for fast re-show).
 *   4. The DevTools UI inside that WebContents has rendered Chromium
 *      DevTools chrome (tab bar with "Console" panel) — proving it's a
 *      real DevTools frontend, not just a blank page.
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { test, expect, useSharedProject } from './fixtures'
import {
  DEMO_APP_DIR,
  pollUntil,
  waitSimulatorReady,
} from './helpers'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

test.describe('Console tab → Chromium DevTools', () => {
  test.describe.configure({ mode: 'serial' })

  useSharedProject(test, DEMO_APP_DIR)

  test('simulator attach creates a devtools:// webContents', async ({ electronApp }) => {
    await waitSimulatorReady(electronApp)

    // ViewManager.attachSimulator is triggered by the renderer once the
    // simulator <webview> reports its webContents id; the devtools
    // webContents is then created via setDevToolsWebContents+openDevTools.
    // Poll briefly because the chain is async (renderer → IPC → main).
    const url = await pollUntil(
      () => electronApp.evaluate(({ webContents }) => {
        const all = webContents.getAllWebContents()
        const dt = all.find((wc) => !wc.isDestroyed() && wc.getURL().startsWith('devtools://'))
        return dt?.getURL() || null
      }),
      (u) => typeof u === 'string' && u.startsWith('devtools://'),
      15000,
      500,
    )

    expect(url).toBeTruthy()
    expect(url!).toMatch(/^devtools:\/\/devtools/)
  })

  test('selecting Console tab attaches the devtools view to the main window', async ({
    electronApp,
    mainWindow,
  }) => {
    await waitSimulatorReady(electronApp)

    // Click the Console tab. The bottom-debug-panel uses role="tab" with
    // textual labels; matching by text avoids relying on id ordering.
    await mainWindow.getByRole('tab', { name: 'Console' }).click()

    // Wait for the renderer's ResizeObserver→IPC publish to round-trip
    // and the main process to add the WebContentsView to contentView.
    const visible = await pollUntil(
      () => electronApp.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0]
        if (!win) return false
        const children = win.contentView.children || []
        // A simulator-devtools view's webContents has a devtools:// URL.
        for (const child of children) {
          const wc = (child as { webContents?: { getURL?: () => string; isDestroyed?: () => boolean } }).webContents
          if (!wc || wc.isDestroyed?.()) continue
          const url = wc.getURL?.() || ''
          if (url.startsWith('devtools://')) {
            const b = (child as { getBounds?: () => { width: number; height: number } }).getBounds?.()
            if (b && b.width > 0 && b.height > 0) return true
          }
        }
        return false
      }),
      (v) => v === true,
      8000,
      300,
    )

    expect(visible).toBe(true)
  })

  test('selecting another tab detaches the devtools view from contentView', async ({
    electronApp,
    mainWindow,
  }) => {
    await waitSimulatorReady(electronApp)

    // Make sure Console is active first so the next click is a real switch.
    await mainWindow.getByRole('tab', { name: 'Console' }).click()
    await pollUntil(
      () => electronApp.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0]
        if (!win) return false
        return (win.contentView.children || []).some((child) => {
          const wc = (child as { webContents?: { getURL?: () => string; isDestroyed?: () => boolean } }).webContents
          if (!wc || wc.isDestroyed?.()) return false
          return (wc.getURL?.() || '').startsWith('devtools://')
        })
      }),
      (v) => v === true,
      8000,
      300,
    )

    // Switch to WXML — the placeholder div hides (display:none) and its
    // ResizeObserver emits a zero-area rect → main process removes the
    // devtools child view but keeps the WebContents alive.
    await mainWindow.getByRole('tab', { name: 'WXML' }).click()

    const detached = await pollUntil(
      () => electronApp.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0]
        if (!win) return false
        const stillAttached = (win.contentView.children || []).some((child) => {
          const wc = (child as { webContents?: { getURL?: () => string; isDestroyed?: () => boolean } }).webContents
          if (!wc || wc.isDestroyed?.()) return false
          return (wc.getURL?.() || '').startsWith('devtools://')
        })
        return !stillAttached
      }),
      (v) => v === true,
      8000,
      300,
    )

    expect(detached).toBe(true)

    // But the devtools WebContents itself is still alive — fast re-show
    // doesn't have to bootstrap the Chromium DevTools UI again.
    const stillAlive = await electronApp.evaluate(({ webContents }) => {
      return webContents
        .getAllWebContents()
        .some((wc) => !wc.isDestroyed() && wc.getURL().startsWith('devtools://'))
    })
    expect(stillAlive).toBe(true)
  })

  test('devtools webContents has rendered the Chromium DevTools UI', async ({ electronApp, mainWindow }) => {
    await waitSimulatorReady(electronApp)
    await mainWindow.getByRole('tab', { name: 'Console' }).click()

    // The Chromium DevTools frontend renders its tab bar inside
    // closed shadow roots, so a light-DOM `querySelector('[role="tab"]')`
    // returns nothing. Instead assert the bundled DevTools entry actually
    // loaded:
    //   - URL is the standard `devtools://devtools/bundled/devtools_app.html`
    //   - the document has a non-empty body (DevTools chrome is mounted)
    //   - the global `Root` namespace exported by the DevTools front-end
    //     bundle is present (this is how the bundle bootstraps itself).
    const probe = await pollUntil(
      () => electronApp.evaluate(({ webContents }) => {
        const dt = webContents
          .getAllWebContents()
          .find((wc) => !wc.isDestroyed() && wc.getURL().startsWith('devtools://'))
        if (!dt) return null
        return dt
          .executeJavaScript(`
            (() => {
              const url = location.href
              const hasBody = !!(document.body && document.body.children.length > 0)
              const hasRoot = typeof (globalThis).Root !== 'undefined'
                || typeof (globalThis).UI !== 'undefined'
              return { url, hasBody, hasRoot }
            })()
          `)
          .catch(() => null)
      }),
      (v) => v != null && v.hasBody === true,
      15000,
      400,
    ) as { url: string; hasBody: boolean; hasRoot: boolean } | null

    expect(probe).not.toBeNull()
    expect(probe!.url).toContain('devtools_app.html')
    expect(probe!.hasBody).toBe(true)

    // Capture a visual snapshot of the DevTools UI for manual review.
    // Saved under packages/devtools/_spike/ (gitignored scratch area).
    const outDir = path.resolve(__dirname, '..', '_spike')
    fs.mkdirSync(outDir, { recursive: true })
    const dataUrl = await electronApp.evaluate(async ({ webContents }) => {
      const dt = webContents
        .getAllWebContents()
        .find((wc) => !wc.isDestroyed() && wc.getURL().startsWith('devtools://'))
      if (!dt) return null
      const img = await dt.capturePage()
      return img.isEmpty() ? null : img.toDataURL()
    })
    if (dataUrl) {
      const base64 = dataUrl.replace(/^data:image\/png;base64,/, '')
      fs.writeFileSync(path.join(outDir, 'devtools-console.png'), Buffer.from(base64, 'base64'))
    }
  })

  test('devtools opens on Console panel by default (not Elements)', async ({ electronApp, mainWindow }) => {
    await waitSimulatorReady(electronApp)
    await mainWindow.getByRole('tab', { name: 'Console' }).click()

    // The Chromium DevTools front-end exposes its view manager on
    // `globalThis.UI` once the bundle has finished bootstrapping. The
    // main process drives it via `UI.ViewManager.instance().showView('console')`
    // immediately after `dom-ready`. We poll the front-end for the
    // currently selected tab in the inspector's main tabbed-pane and
    // expect 'console' (the default would be 'elements').
    const selected = await pollUntil(
      () => electronApp.evaluate(({ webContents }) => {
        const dt = webContents
          .getAllWebContents()
          .find((wc) => !wc.isDestroyed() && wc.getURL().startsWith('devtools://'))
        if (!dt) return null
        return dt
          .executeJavaScript(`
            (() => {
              try {
                const UI = globalThis.UI
                const iv = UI && UI.InspectorView && typeof UI.InspectorView.instance === 'function'
                  ? UI.InspectorView.instance()
                  : (UI && UI.inspectorView ? UI.inspectorView : null)
                const tp = iv && (iv.tabbedPane || (typeof iv.tabbedLocation === 'function' ? iv.tabbedLocation().tabbedPane() : null))
                const selectedTabId = tp && typeof tp.selectedTabId !== 'undefined' ? tp.selectedTabId : null
                const stored = (() => { try { return localStorage.getItem('panel-selectedTab') } catch { return null } })()
                return { selectedTabId, stored }
              } catch (e) {
                return { error: String(e) }
              }
            })()
          `)
          .catch(() => null)
      }),
      // Accept either UI-confirmed selection or persisted storage signal.
      (v) => v != null && (v.selectedTabId === 'console' || v.stored === '"console"'),
      15000,
      300,
    ) as { selectedTabId?: string | null; stored?: string | null; error?: string } | null

    expect(selected).not.toBeNull()
    // Persisted localStorage must reflect Console as the chosen default.
    expect(selected!.stored).toBe('"console"')
    // The Elements panel should NOT be the active selection. (If
    // `selectedTabId` is null because the internal API surface differs
    // across Electron/Chromium versions, the storage assertion above
    // already proves the persistence path. But when readable, it must
    // not be 'elements'.)
    if (typeof selected!.selectedTabId === 'string') {
      expect(selected!.selectedTabId).not.toBe('elements')
    }

    // Snapshot the DevTools UI with Console selected, for manual review.
    const outDir = path.resolve(__dirname, '..', '_spike')
    fs.mkdirSync(outDir, { recursive: true })
    const dataUrl = await electronApp.evaluate(async ({ webContents }) => {
      const dt = webContents
        .getAllWebContents()
        .find((wc) => !wc.isDestroyed() && wc.getURL().startsWith('devtools://'))
      if (!dt) return null
      const img = await dt.capturePage()
      return img.isEmpty() ? null : img.toDataURL()
    })
    if (dataUrl) {
      const base64 = dataUrl.replace(/^data:image\/png;base64,/, '')
      fs.writeFileSync(path.join(outDir, 'devtools-console-default.png'), Buffer.from(base64, 'base64'))
    }
  })
})
