import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test'
import path from 'path'
import { fileURLToPath } from 'url'
import { pollUntil } from './helpers'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.resolve(__dirname, 'fixtures', 'host-dialog')

/**
 * Host dialog: by-demand, dual-axis, main-window-centered overlay
 * (host-dialog-view.ts). Unlike host-toolbar/host-sidebar it has no renderer
 * placeholder to anchor against — its own reverse advertiser (both axes) is
 * the only geometry input, and main re-centers it in the current main-window
 * content rect on every `show()` / measured-extent report.
 *
 * Electron e2e; runs on local macOS without extra setup (NODE_ENV=test,
 * off-screen windows).
 */
test.describe('Host dialog: by-demand, dual-axis, main-centered overlay', () => {
  test.setTimeout(120_000)
  test.describe.configure({ mode: 'serial' })

  let electronApp: ElectronApplication
  let mainWindow: Page

  test.beforeAll(async () => {
    const entryPath = path.resolve(__dirname, 'host-dialog-entry.js')
    electronApp = await _electron.launch({
      args: [entryPath],
      env: {
        ...process.env,
        NODE_ENV: 'test',
      },
    })
    mainWindow = await electronApp.firstWindow()
    await mainWindow.waitForLoadState('domcontentloaded')
  })

  test.afterAll(async () => {
    await Promise.race([
      electronApp?.close().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 15_000)),
    ])
  })

  /** The dialog WCV's live `getBounds()`, or null if not attached to any window. */
  const dialogBounds = () => electronApp.evaluate(({ BrowserWindow }) => {
    const g = globalThis as unknown as {
      __e2eHostDialogInstance: {
        context: { views: { hostDialog: { webContents: { id: number } | null } } }
      }
    }
    const wc = g.__e2eHostDialogInstance.context.views.hostDialog.webContents
    if (!wc) return null
    for (const win of BrowserWindow.getAllWindows()) {
      const view = (
        win.contentView.children as Array<{
          webContents?: { id: number }
          getBounds(): { x: number; y: number; width: number; height: number }
        }>
      ).find((v) => v.webContents?.id === wc.id)
      if (view) return view.getBounds()
    }
    return null
  })

  const mainContentSize = () => electronApp.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    const [width, height] = win.getContentSize()
    return { width, height }
  })

  test('loadFile + show(): centers a fixed-size fixture in the main window content rect', async () => {
    await electronApp.evaluate((_electronMods, file) => {
      const g = globalThis as unknown as {
        __e2eHostDialogInstance: {
          context: { views: { hostDialog: { loadFile(p: string): Promise<void>; show(): void } } }
        }
      }
      const dialog = g.__e2eHostDialogInstance.context.views.hostDialog
      return dialog.loadFile(file).then(() => dialog.show())
    }, path.join(FIXTURES, 'dialog-fixed.html'))

    const bounds = await pollUntil(
      dialogBounds,
      (b) => b !== null && b.width === 300 && b.height === 200,
      15_000,
      300,
    )
    expect(bounds).not.toBeNull()
    const { width: winW, height: winH } = await mainContentSize()
    expect(bounds!.x).toBeCloseTo((winW - bounds!.width) / 2, 0)
    expect(bounds!.y).toBeCloseTo((winH - bounds!.height) / 2, 0)
  })

  test('content resize re-centers the dialog instead of leaving it at the old bounds', async () => {
    await electronApp.evaluate((_electronMods, file) => {
      const g = globalThis as unknown as {
        __e2eHostDialogInstance: {
          context: { views: { hostDialog: { loadFile(p: string): Promise<void>; show(): void } } }
        }
      }
      const dialog = g.__e2eHostDialogInstance.context.views.hostDialog
      return dialog.loadFile(file).then(() => dialog.show())
    }, path.join(FIXTURES, 'dialog-resizable.html'))

    await pollUntil(
      dialogBounds,
      (b) => b !== null && b.width === 300 && b.height === 200,
      15_000,
      300,
    )

    // Trigger the fixture's own grow button (its click handler resizes the
    // shrink-to-fit content, which the ResizeObserver-driven advertiser picks
    // up automatically — no test-injected business logic).
    await electronApp.evaluate((_electronMods) => {
      const g = globalThis as unknown as {
        __e2eHostDialogInstance: {
          context: {
            views: { hostDialog: { webContents: { executeJavaScript(code: string): Promise<unknown> } | null } }
          }
        }
      }
      const wc = g.__e2eHostDialogInstance.context.views.hostDialog.webContents
      return wc?.executeJavaScript("document.getElementById('grow').click()")
    })

    const bounds = await pollUntil(
      dialogBounds,
      (b) => b !== null && b.width === 500 && b.height === 350,
      15_000,
      300,
    )
    expect(bounds).not.toBeNull()
    const { width: winW, height: winH } = await mainContentSize()
    expect(bounds!.x).toBeCloseTo((winW - bounds!.width) / 2, 0)
    expect(bounds!.y).toBeCloseTo((winH - bounds!.height) / 2, 0)
  })

  test('main-window resize re-centers the dialog in the new content rect', async () => {
    await electronApp.evaluate((_electronMods, file) => {
      const g = globalThis as unknown as {
        __e2eHostDialogInstance: {
          context: { views: { hostDialog: { loadFile(p: string): Promise<void>; show(): void } } }
        }
      }
      const dialog = g.__e2eHostDialogInstance.context.views.hostDialog
      return dialog.loadFile(file).then(() => dialog.show())
    }, path.join(FIXTURES, 'dialog-fixed.html'))

    await pollUntil(
      dialogBounds,
      (b) => b !== null && b.width === 300 && b.height === 200,
      15_000,
      300,
    )

    // Resize the real BrowserWindow — this is the production entry point
    // (app.ts's onResize -> ViewManager.repositionAll()), not a direct call
    // into the dialog's own reposition().
    const { width: prevW, height: prevH } = await mainContentSize()
    await electronApp.evaluate(({ BrowserWindow }, [w, h]) => {
      BrowserWindow.getAllWindows()[0]!.setContentSize(w, h)
    }, [prevW + 200, prevH + 150])

    const { width: winW, height: winH } = await mainContentSize()
    const bounds = await pollUntil(
      dialogBounds,
      (b) => b !== null && Math.abs(b.x - (winW - 300) / 2) < 1 && Math.abs(b.y - (winH - 200) / 2) < 1,
      15_000,
      300,
    )
    expect(bounds).not.toBeNull()
  })

  test('loadFile() into a new fixture ends up at the new document\'s own size, not the previous document\'s', async () => {
    // Currently showing dialog-fixed.html at 300x200 (previous test). Swap in
    // a fixture whose OWN size (350x250) is distinct from both that 300x200
    // and the DEFAULT_WIDTH/HEIGHT (480x320) fallback, so a settled 350x250
    // can only mean this document's own measurement won out, never a
    // leftover from the fixture this dialog view previously showed.
    //
    // This does NOT probe the frame right after `show()` returns (an earlier
    // version of this test did): by the time this spec's own separate
    // `dialogBounds()` round-trip observes the WCV, the new document's
    // advertiser round-trip has, empirically, always already landed too —
    // confirmed by disabling the main-side reset and finding this same
    // "immediate" check still passed. The reset-before-any-report invariant
    // is real and load-bearing (a document that reports NOTHING, e.g. a
    // fixture missing `[data-host-dialog-root]`, would otherwise inherit the
    // previous one's exact bounds forever), it's just only deterministically
    // observable with synchronous mocked time — see host-dialog.test.ts's
    // 'ViewManager: hostDialog content swap resets the advertised size'.
    await electronApp.evaluate((_electronMods, file) => {
      const g = globalThis as unknown as {
        __e2eHostDialogInstance: {
          context: { views: { hostDialog: { loadFile(p: string): Promise<void>; show(): void } } }
        }
      }
      const dialog = g.__e2eHostDialogInstance.context.views.hostDialog
      return dialog.loadFile(file).then(() => dialog.show())
    }, path.join(FIXTURES, 'dialog-other-size.html'))

    const bounds = await pollUntil(
      dialogBounds,
      (b) => b !== null && b.width === 350 && b.height === 250,
      15_000,
      300,
    )
    expect(bounds).not.toBeNull()
  })

  test('hide(): removes the dialog WCV from the window contentView', async () => {
    // Meaningfulness guard: it really is attached before hiding.
    expect(await dialogBounds()).not.toBeNull()

    await electronApp.evaluate((_electronMods) => {
      const g = globalThis as unknown as {
        __e2eHostDialogInstance: { context: { views: { hostDialog: { hide(): void } } } }
      }
      g.__e2eHostDialogInstance.context.views.hostDialog.hide()
    })

    const gone = await pollUntil(dialogBounds, (b) => b === null, 15_000, 300)
    expect(gone).toBeNull()
  })
})
