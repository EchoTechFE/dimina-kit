import { test, expect, useSharedProject } from './fixtures'
import { DEMO_APP_DIR } from './helpers'

/**
 * Real-Electron verification for the standalone internal (app-wide) DevTools
 * debug window. Unit tests (vitest, mocked Electron) already pin the window
 * controller's build-once/reuse/hide-on-close contract in isolation; this
 * spec proves the actual button → IPC → main process → real BrowserWindow
 * chain works end-to-end against the built app.
 */
test.describe('Internal (app-wide) DevTools window', () => {
  test.describe.configure({ mode: 'serial' })

  useSharedProject(test, DEMO_APP_DIR)

  test('debug button is visible in the simulator bottom bar', async ({ mainWindow }) => {
    await expect(mainWindow.getByTestId('sim-open-internal-devtools')).toBeVisible()
  })

  test('clicking it opens exactly one new BrowserWindow, titled for whole-app debugging', async ({ mainWindow, electronApp }) => {
    const before = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)

    await mainWindow.getByTestId('sim-open-internal-devtools').click()

    await expect.poll(
      async () => electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
      { message: 'internal devtools window should open as one new BrowserWindow', timeout: 10_000 },
    ).toBe(before + 1)

    const titles = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.getTitle()))
    expect(titles.some((t) => t.includes('调试'))).toBe(true)
  })

  test('clicking it again reuses the same window (no second BrowserWindow)', async ({ mainWindow, electronApp }) => {
    const countAfterFirstOpen = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)

    await mainWindow.getByTestId('sim-open-internal-devtools').click()
    // Give main a beat to process the (idempotent) IPC round trip.
    await mainWindow.waitForTimeout(300)

    const countAfterSecondClick = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
    expect(countAfterSecondClick).toBe(countAfterFirstOpen)
  })

  test('closing it hides rather than destroys — reopening reuses the SAME window', async ({ mainWindow, electronApp }) => {
    // Baseline BEFORE closing — the app also carries a permanently-hidden
    // "Dimina Service Host" BrowserWindow (id:2 in a real run, always
    // present, unrelated to this feature), so an ABSOLUTE window count
    // assertion is wrong here; only the DELTA around the close/reopen
    // matters (matches the pattern already used in the tests above).
    const countBeforeClose = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)

    // Close whichever window is NOT the main window (the internal devtools
    // window opened by the previous tests in this serial file). The native
    // close is intercepted and hides rather than destroys (see
    // internal-devtools-window/index.ts's module doc: rebuilding this
    // window's DevTools attachment on every close/reopen cannot be made
    // reliable — Electron/Chromium can take 20+ seconds to actually detach
    // the previous front-end, with no fast completion signal), so the
    // window count must NOT drop and the window must become invisible.
    const closed = await electronApp.evaluate(({ BrowserWindow }) => {
      const wins = BrowserWindow.getAllWindows()
      const target = wins.find((w) => w.getTitle().includes('调试'))
      if (!target) return false
      target.close()
      return true
    })
    expect(closed).toBe(true)

    await expect.poll(
      async () => electronApp.evaluate(({ BrowserWindow }) => {
        const target = BrowserWindow.getAllWindows().find((w) => w.getTitle().includes('调试'))
        return target ? target.isVisible() : null
      }),
      { message: 'internal devtools window should hide (not close) after the native close', timeout: 10_000 },
    ).toBe(false)

    const countAfterClose = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
    expect(countAfterClose, 'closing the internal devtools window must not destroy it').toBe(countBeforeClose)

    await mainWindow.getByTestId('sim-open-internal-devtools').click()

    await expect.poll(
      async () => electronApp.evaluate(({ BrowserWindow }) => {
        const target = BrowserWindow.getAllWindows().find((w) => w.getTitle().includes('调试'))
        return target ? target.isVisible() : null
      }),
      { message: 'internal devtools window should become visible again on reopen', timeout: 10_000 },
    ).toBe(true)

    const countAfterReopen = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
    expect(countAfterReopen, 'reopening after a close must reuse the SAME window, not build a new one').toBe(countBeforeClose)
  })
})
