/**
 * E2E: the ServiceHostPool pre-warm path (opt-in via DIMINA_PREWARM_POOL_SIZE) is
 * exercised in REAL Electron — the unit suite (pool.test.ts) mocks BrowserWindow,
 * so only a launched app proves the two Phase-3 blockers are actually resolved:
 *   1. shared-session storage wipe → serviceHostSpec sets
 *      clearStorageOnReset:false, so warming/reset doesn't clear persist:simulator;
 *   2. preload-warming contract → service-host/preload.cjs idles when `bridgeId`
 *      is absent, so warming on about:blank doesn't abort the preload and a
 *      pooled window can still boot the real app after acquire+navigate.
 *
 * The pool only runs under native-host (bridge-router.handleSpawn is the native
 * spawn hub), and warming starts ~500ms after app.ready (installBridgeRouter),
 * BEFORE a project is opened. So this launches DIMINA_NATIVE_HOST=1 +
 * DIMINA_PREWARM_POOL_SIZE=2, waits for the 2 warm spares to settle, records
 * their BrowserWindow ids, THEN opens the project — making the spawn's acquire a
 * guaranteed pool HIT. It then proves PROVENANCE: the booted service-host window
 * is one of the pre-recorded warm windows (id reused), not a fresh fallback.
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
import { AutomationChannel, SimulatorWxmlChannel } from '../src/shared/ipc-channels'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = path.resolve(__dirname, 'fixtures', 'tabbar-app')

let electronApp: ElectronApplication
let mainWindow: PwPage
let userDataDir: string
// BrowserWindow ids of the warm (about:blank) service-host spares, captured
// BEFORE the project is opened (so the spawn's acquire is a guaranteed pool hit).
let warmWindowIds: number[] = []

/** Snapshot the BrowserWindows that are currently parked on about:blank. */
function aboutBlankWindows(): Promise<Array<{ id: number; visible: boolean }>> {
  return electronApp.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .filter((w) => {
        try { return w.webContents.getURL().startsWith('about:blank') } catch { return false }
      })
      .map((w) => ({ id: w.id, visible: (() => { try { return w.isVisible() } catch { return false } })() })),
  )
}

test.describe('ServiceHostPool pre-warm (pool-ON) e2e', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(180_000)

  test.beforeAll(async () => {
    const appPath = path.resolve(__dirname, 'electron-entry.js')
    userDataDir = path.resolve(
      process.env.DIMINA_DEVTOOLS_DATA_DIR
        ?? path.resolve(__dirname, '..', 'node_modules', '.cache', 'devtools-e2e'),
      'userdata',
      `prewarm-${process.pid}`,
    )
    fs.mkdirSync(userDataDir, { recursive: true })

    electronApp = await _electron.launch({
      args: [appPath, 'auto', '--auto-port', '0', `--user-data-dir=${userDataDir}`],
      // DIMINA_PREWARM_POOL_SIZE turns the pool ON (default OFF); scoped to THIS
      // launch so the shared --workers=1 runner isn't flipped into pool mode.
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DIMINA_NATIVE_HOST: '1',
        DIMINA_PREWARM_POOL_SIZE: '2',
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

    // Wait for both warm spares to settle (pool init warms 2 hidden about:blank
    // service windows ~500ms after app.ready), THEN record their ids — so the
    // spawn below is a guaranteed pool hit and we can prove provenance.
    const warm = await pollUntil(
      () => aboutBlankWindows().catch(() => []),
      (wins) => wins.filter((w) => !w.visible).length >= 2,
      25000,
      400,
    )
    warmWindowIds = warm.filter((w) => !w.visible).map((w) => w.id)

    await openProjectInUI(mainWindow, FIXTURE_DIR, { waitMs: 20000 })
    await waitForSimulatorWebview(electronApp)
  })

  test.afterAll(async () => {
    await closeProject(mainWindow).catch(() => {})
    await electronApp?.close().catch(() => {})
    // Don't orphan the per-pid userdata tree (a persist:simulator profile).
    if (userDataDir) {
      try { fs.rmSync(userDataDir, { recursive: true, force: true }) } catch { /* best-effort */ }
    }
  })

  test('warms 2 spare service-host windows before the project opens', () => {
    // Recorded in beforeAll. The non-pool path never creates a hidden about:blank
    // BrowserWindow, so this is the load-bearing discriminator that warming ran.
    expect(warmWindowIds.length, 'pool should warm 2 about:blank service-host spares').toBeGreaterThanOrEqual(2)
  })

  test('the spawned service-host window was acquired FROM the pool (id provenance)', async () => {
    // After the spawn, find the live service.html BrowserWindow and prove its id
    // is one of the pre-recorded warm spares — i.e. acquire reused a warm window
    // (navigated about:blank → service.html) rather than falling back to a fresh
    // BrowserWindow. This is the assertion that proves the app was served THROUGH
    // the pool, not merely that it rendered under pool-ON config.
    const serviceId = await pollUntil(
      () => electronApp.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows().find((win) => {
          try { return win.webContents.getURL().includes('service.html') } catch { return false }
        })
        return w ? w.id : null
      }).catch(() => null),
      (id) => typeof id === 'number',
      30000,
      400,
    )
    expect(serviceId, 'a service.html BrowserWindow should exist after spawn').not.toBeNull()
    expect(
      warmWindowIds.includes(serviceId as number),
      `service window id ${serviceId} should be one of the pre-warmed pool spares ${JSON.stringify(warmWindowIds)} (pool HIT, not a fresh fallback)`,
    ).toBe(true)

    // And one warm spare should remain (acquire consumed 1 of 2, no auto-refill).
    const blank = await aboutBlankWindows()
    expect(blank.filter((w) => !w.visible).length, 'one warm about:blank spare should remain').toBeGreaterThanOrEqual(1)
  })

  test('the app spawns + renders through the pooled service-host window', async () => {
    // Proves blocker #2 is resolved: the pooled window warmed on about:blank
    // (preload idled), then acquire+navigate to service.html booted the real app
    // — DeviceShell paints its per-page render webview, and the service→render
    // tap feeds the main-process panel pipeline.
    const webviewCount = await pollUntil(
      () => evalInSimulator<number>(
        electronApp,
        `(() => document.querySelectorAll('.device-shell__webview').length)()`,
      ).catch(() => 0),
      (n) => n >= 1,
      30000,
      400,
    )
    expect(webviewCount, 'a render-host webview should mount under pool-ON native-host').toBeGreaterThanOrEqual(1)

    const tree = await pollUntil(
      () => ipcInvoke<{ tagName?: string } | null>(mainWindow, SimulatorWxmlChannel.GetSnapshot).catch(() => null),
      (t) => !!t && typeof t.tagName === 'string',
      30000,
      400,
    )
    expect(tree, 'WXML snapshot should be populated from the pooled session').toBeTruthy()
  })
})
