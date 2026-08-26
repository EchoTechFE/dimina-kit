import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test'
import path from 'path'
import { fileURLToPath } from 'url'
import { DEMO_APP_DIR, openProjectInUI, pollUntil } from './helpers'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TOOLBAR_FIXTURES = path.resolve(__dirname, 'fixtures', 'host-toolbar')

/**
 * Real-Electron companion to `view-manager-dialog-zorder.test.ts`'s mocked
 * `addChildView` spy: a native WebContentsView (the simulator, the
 * host-toolbar strip) mounted on top of the main window's own renderer would
 * paint OVER any dialog living as a `fixed inset-0` DOM portal inside that
 * same occluded renderer. Both dialogs render in their own overlay WCV at
 * `VIEW_LAYER.dialog` (40) instead — above `hostToolbar`/`hostSidebar` (5) and
 * the simulator's base layer (0). This spec proves the ordering holds in a
 * real `win.contentView.children` tree, not just against a mock.
 *
 * Electron e2e; runs on local macOS without extra setup (NODE_ENV=test,
 * off-screen windows).
 */
test.describe('Dialog overlay z-order (real Electron): update dialog stays above the live simulator/host-toolbar WCVs', () => {
  test.setTimeout(120_000)
  test.describe.configure({ mode: 'serial' })

  let electronApp: ElectronApplication
  let mainWindow: Page

  test.beforeAll(async () => {
    const entryPath = path.resolve(__dirname, 'dialog-zorder-entry.js')
    electronApp = await _electron.launch({
      args: [entryPath],
      env: { ...process.env, NODE_ENV: 'test' },
    })
    mainWindow = await electronApp.firstWindow()
    await mainWindow.waitForLoadState('domcontentloaded')
    await openProjectInUI(mainWindow, DEMO_APP_DIR, { waitMs: 20_000 })

    // Give the host-toolbar a live, sized strip so it actually attaches to
    // the window's contentView — the occlusion bug required an ACTUAL native
    // view mounted above the main window's renderer, not just a placeholder
    // waiting for content.
    await electronApp.evaluate((_electronMods, file) => {
      const g = globalThis as unknown as {
        __e2eDialogZorderInstance: {
          context: { views: { hostToolbar: { loadFile(p: string): Promise<void> } } }
        }
      }
      return g.__e2eDialogZorderInstance.context.views.hostToolbar.loadFile(file)
    }, path.join(TOOLBAR_FIXTURES, 'toolbar-64.html'))

    await pollUntil(
      () => mainWindow.evaluate(() => {
        const el = document.querySelector('[data-area="host-toolbar"]')
        return el ? Math.round(el.getBoundingClientRect().height) : -1
      }),
      (h) => h === 64,
      30_000,
      300,
    )
  })

  test.afterAll(async () => {
    await Promise.race([
      electronApp?.close().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 15_000)),
    ])
  })

  test('showUpdateDialog attaches its WCV above the live simulator and host-toolbar WCVs', async () => {
    const simulatorWcId = await electronApp.evaluate(() => {
      const g = globalThis as unknown as {
        __e2eDialogZorderInstance: { context: { views: { getSimulatorWebContentsId(): number | null } } }
      }
      return g.__e2eDialogZorderInstance.context.views.getSimulatorWebContentsId()
    })
    expect(simulatorWcId, 'simulator WCV must be live before the z-order check is meaningful').not.toBeNull()

    const toolbarWcId = await electronApp.evaluate(() => {
      const g = globalThis as unknown as {
        __e2eDialogZorderInstance: { context: { views: { getHostToolbarWebContentsId(): number | null } } }
      }
      return g.__e2eDialogZorderInstance.context.views.getHostToolbarWebContentsId()
    })
    expect(toolbarWcId, 'host-toolbar WCV must be live before the z-order check is meaningful').not.toBeNull()

    const dialogWcId = await electronApp.evaluate(() => {
      const g = globalThis as unknown as {
        __e2eDialogZorderInstance: {
          context: {
            views: {
              showUpdateDialog(info: { version: string; downloadUrl: string }): void
              getUpdateDialogWebContentsId(): number | null
              markOverlayReady(id: number): void
            }
          }
        }
      }
      const views = g.__e2eDialogZorderInstance.context.views
      views.showUpdateDialog({ version: '2.0.0', downloadUrl: 'https://example.com/2.0.0.dmg' })
      const id = views.getUpdateDialogWebContentsId()
      if (id !== null) views.markOverlayReady(id)
      return id
    })
    expect(dialogWcId, 'update dialog WCV must be created by showUpdateDialog').not.toBeNull()

    // ANTI-CHEAT: this is the exact observable the original occlusion bug
    // produced — the dialog WAS present in the DOM, just visually behind the
    // native WCVs, because `win.contentView.children` ordered it below them.
    // An implementation that regresses to that ordering (or never attaches
    // the dialog at all) must fail this assertion.
    // Search every window (not just index 0 — other windows, e.g. an
    // internal devtools inspector, can outrank the main window in creation
    // order) for the one whose contentView actually hosts the simulator, the
    // ground truth for "the window under test" independent of the dialog.
    const order = await pollUntil(
      () => electronApp.evaluate(({ BrowserWindow }, simId) => {
        for (const win of BrowserWindow.getAllWindows()) {
          const children = win.contentView.children as Array<{ webContents?: { id: number } }>
          const ids = children.map((v) => v.webContents?.id).filter((id): id is number => id !== undefined)
          if (ids.includes(simId)) return ids
        }
        return []
      }, simulatorWcId as number),
      (ids) => ids.includes(dialogWcId as number),
      15_000,
      300,
    )

    const dialogIndex = order.indexOf(dialogWcId as number)
    const simulatorIndex = order.indexOf(simulatorWcId as number)
    const toolbarIndex = order.indexOf(toolbarWcId as number)
    expect(dialogIndex).toBeGreaterThan(simulatorIndex)
    expect(dialogIndex).toBeGreaterThan(toolbarIndex)
  })
})
