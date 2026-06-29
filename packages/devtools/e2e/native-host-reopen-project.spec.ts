/**
 * E2E (native-host only): opening a second project after closing the first
 * must create a fresh render guest and must NOT leave stale render guests
 * from the closed project alive in the main process.
 *
 * Under native-host each project session spawns render-host WebContents
 * (pageFrame.html webviews inside the DeviceShell). Closing a project must
 * destroy those WebContents; re-opening (or opening a different project)
 * must create new ones. If old guests survive close, the simulator can
 * render stale content from the closed project while the new project's
 * guests also attempt to mount — producing a blank or stale simulator view.
 *
 * The discriminating observable is the `bridgeId` query parameter embedded
 * in the render-host guest URL (e.g. `pageFrame.html?bridgeId=<n>`).
 * Each session allocates a fresh bridgeId, so:
 *
 *   1. After opening project A, the DeviceShell's <webview> src contains
 *      bridgeId_A.
 *   2. After closing A and opening project B, the DeviceShell's <webview>
 *      src must contain a DIFFERENT bridgeId (bridgeId_B ≠ bridgeId_A),
 *      proving a new session was allocated.
 *   3. No live WebContents whose URL still contains bridgeId_A must survive:
 *      getAllWebContents() must not include any non-destroyed wc whose URL
 *      contains both `pageFrame.html` and bridgeId_A. This is the direct
 *      assertion that old guests were torn down.
 *
 * Fixture pair:
 *   A = tabbar-app  (has tabBar config)
 *   B = navbar-app  (no tabBar config)
 *
 * Two structurally different apps make residual state from A visible
 * independent of the bridgeId check: if the DeviceShell still shows A's
 * webview src after B opens, the bridgeId comparison also catches it.
 */
import { test, expect, _electron, type ElectronApplication, type Page as PwPage } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import {
  openProjectInUI,
  waitForSimulatorWebview,
  closeProject,
  ipcInvoke,
  pollUntil,
  evalInSimulator,
} from './helpers'
import { AutomationChannel } from '../src/shared/ipc-channels'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_A = path.resolve(__dirname, 'fixtures', 'tabbar-app')
const FIXTURE_B = path.resolve(__dirname, 'fixtures', 'navbar-app')

/**
 * Extract the bridgeId from the DeviceShell's active render-host webview src.
 * Returns null when no `.device-shell__webview` element is present.
 */
async function getActiveBridgeId(electronApp: ElectronApplication): Promise<string | null> {
  try {
    return await evalInSimulator<string | null>(
      electronApp,
      `(() => {
        const wv = document.querySelector('.device-shell__webview')
        if (!wv) return null
        const src = wv.getAttribute('src') || ''
        const m = src.match(/[?&]bridgeId=([^&]+)/)
        return m ? m[1] : null
      })()`,
    )
  } catch {
    return null
  }
}

/**
 * Count live render guest WebContents (pageFrame.html) in the main process.
 * A guest is "live" when it is not destroyed and its URL contains 'pageFrame.html'.
 */
function countLiveGuests(electronApp: ElectronApplication): Promise<number> {
  return electronApp.evaluate(({ webContents }) =>
    webContents
      .getAllWebContents()
      .filter((wc) => !wc.isDestroyed() && wc.getURL().includes('pageFrame.html'))
      .length,
  )
}

/**
 * Return true if any non-destroyed WebContents URL includes both
 * `pageFrame.html` and the supplied bridgeId string.
 */
function bridgeIdStillLive(electronApp: ElectronApplication, bridgeId: string): Promise<boolean> {
  return electronApp.evaluate(
    ({ webContents }, id) =>
      webContents
        .getAllWebContents()
        .some(
          (wc) =>
            !wc.isDestroyed() &&
            wc.getURL().includes('pageFrame.html') &&
            wc.getURL().includes(id),
        ),
    bridgeId,
  )
}

test.describe('native-host close + reopen disposes old render guests and mounts fresh ones', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(240_000)

  let electronApp: ElectronApplication
  let mainWindow: PwPage

  test.beforeAll(async () => {
    // Extend the hook timeout: Electron cold-boot can exceed the 60s config
    // default. Setting it INSIDE the hook overrides the hook's own budget (the
    // describe-level setTimeout only covers tests).
    test.setTimeout(180_000)
    const appPath = path.resolve(__dirname, 'electron-entry.js')
    const userDataDir = path.resolve(
      process.env.DIMINA_DEVTOOLS_DATA_DIR
        ?? path.resolve(__dirname, '..', 'node_modules', '.cache', 'devtools-e2e'),
      'userdata',
      `nh-reopen-${process.pid}`,
    )
    fs.mkdirSync(userDataDir, { recursive: true })

    electronApp = await _electron.launch({
      args: [appPath, 'auto', '--auto-port', '0', `--user-data-dir=${userDataDir}`],
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DIMINA_NATIVE_HOST: '1',
        DIMINA_E2E_USER_DATA_DIR: userDataDir,
      },
    })

    mainWindow = await electronApp.firstWindow()
    await mainWindow.waitForLoadState('domcontentloaded')

    await electronApp.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (win && !win.isVisible()) {
        await new Promise<void>((resolve) => {
          win.once('show', resolve)
          setTimeout(resolve, 5000)
        })
      }
      if (win) {
        win.setPosition(-2000, -2000)
        win.blur()
      }
    })

    await pollUntil(
      () => ipcInvoke<number | null>(mainWindow, AutomationChannel.GetPort),
      (val) => typeof val === 'number' && val > 0,
      10000,
      100,
    )
  })

  test.afterAll(async () => {
    await closeProject(mainWindow).catch(() => {})
    await electronApp?.close().catch(() => {})
  })

  test('close disposes render guests and reopen mounts fresh guests with a new bridgeId', async () => {
    // ── Phase 1: open project A ──────────────────────────────────────────────

    await openProjectInUI(mainWindow, FIXTURE_A, { waitMs: 25000 })
    await waitForSimulatorWebview(electronApp)

    // Wait until the DeviceShell has mounted a render guest with a bridgeId.
    const bridgeIdA = await pollUntil(
      () => getActiveBridgeId(electronApp),
      (id) => typeof id === 'string' && id.length > 0,
      30000,
      400,
    ) as string

    expect(bridgeIdA, 'project A must have an active render guest with a bridgeId').toBeTruthy()

    // At least one live guest must exist for project A.
    const guestCountA = await countLiveGuests(electronApp)
    expect(guestCountA, 'project A must have at least one live render guest').toBeGreaterThanOrEqual(1)

    // ── Phase 2: close project A ─────────────────────────────────────────────

    await closeProject(mainWindow)

    // After close, all render guests from project A must be destroyed.
    // If they are not (bug), this poll times out and the test fails with a
    // clear message about stale guests surviving the close.
    await pollUntil(
      () => countLiveGuests(electronApp),
      (n) => n === 0,
      15000,
      300,
    ).catch(() => {
      // The final poll attempt will throw; re-throw after the expect below.
    })

    const guestCountAfterClose = await countLiveGuests(electronApp)
    expect(
      guestCountAfterClose,
      `all render guests from project A (bridgeId ${bridgeIdA}) must be destroyed after close`,
    ).toBe(0)

    // ── Phase 3: open project B ──────────────────────────────────────────────

    await openProjectInUI(mainWindow, FIXTURE_B, { waitMs: 25000 })
    await waitForSimulatorWebview(electronApp)

    // Wait until the DeviceShell has mounted a NEW render guest with a
    // different bridgeId.
    const bridgeIdB = await pollUntil(
      () => getActiveBridgeId(electronApp),
      (id) => typeof id === 'string' && id.length > 0 && id !== bridgeIdA,
      30000,
      400,
    ).catch(() => null) as string | null

    expect(
      bridgeIdB,
      `project B must have an active render guest with a new bridgeId (not ${bridgeIdA})`,
    ).toBeTruthy()

    expect(
      bridgeIdB,
      'project B render guest must have a different bridgeId than project A',
    ).not.toBe(bridgeIdA)

    // Core contract: no WebContents whose URL still contains bridgeId_A must
    // survive in the main process after project B is open. A survivor means
    // the old guest was not torn down (the reopen residue bug).
    const oldGuestStillLive = await bridgeIdStillLive(electronApp, bridgeIdA)
    expect(
      oldGuestStillLive,
      `render guest with bridgeId ${bridgeIdA} (project A) must be destroyed before project B opens; ` +
      `a survivor indicates old guests were not torn down on close`,
    ).toBe(false)

    // At least one live guest for project B confirms the new session rendered.
    const guestCountB = await countLiveGuests(electronApp)
    expect(guestCountB, 'project B must have at least one live render guest').toBeGreaterThanOrEqual(1)
  })
})
