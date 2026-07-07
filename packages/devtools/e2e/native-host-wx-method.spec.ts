/**
 * E2E (native-host only): `App.callWxMethod` must work for a NON-navigation
 * `wx.*` method under DIMINA_NATIVE_HOST=1.
 *
 * Navigation methods (navigateTo/redirectTo/reLaunch/switchTab/navigateBack)
 * route correctly under native-host — see
 * `native-host-render.spec.ts` ("App.callWxMethod switchTab navigates …"):
 * the handler special-cases NAV_METHODS and runs them on the authoritative
 * service-host `wx`. This spec pins the same guarantee for a NON-nav wx
 * method that drives the mini-app UI (here `setNavigationBarTitle`): it must
 * ALSO reach the service-host `wx` so its effect is real, rather than falling
 * through to `evalInSim` → the simulator TOP-window `wx`, which under
 * native-host exposes only nav + a few sync helpers and does NOT carry
 * `setNavigationBarTitle`.
 *
 * Chosen method + assertion (see report): `setNavigationBarTitle` with
 * `{ title: 'C5-PROBE' }`, asserting the DeviceShell nav-bar title text
 * (`.nav-bar__title-text` in the simulator WebContentsView DOM, see
 * `src/simulator/device-shell/navigation-bar.tsx`) changes from the fixture's
 * "TabBar Fixture" to "C5-PROBE".
 *
 * Why the side-effect contract and NOT `getSystemInfoSync`: the simulator
 * top-window `wx` happens to carry that sync helper, so
 * `App.callWxMethod('getSystemInfoSync')` returns a usable result regardless
 * of whether non-nav methods route to the service-host `wx` — it does NOT
 * discriminate the contract. `setNavigationBarTitle` is a non-nav method that
 * the top-window `wx` lacks, so it is the discriminating contract for
 * "non-nav wx must route to the service-host wx under native-host".
 */
import { test, expect, _electron, type ElectronApplication, type Page as PwPage } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { WebSocket } from 'ws'
import {
  openProjectInUI,
  waitForSimulatorWebview,
  closeProject,
  ipcInvoke,
  pollUntil,
  evalInSimulator,
} from './helpers'
import { AutomationChannel } from '../src/shared/ipc-channels'

// NOTE: scope DIMINA_NATIVE_HOST to THIS spec's electron launch (below), never
// `process.env` — a module-top mutation poisons the shared --workers=1 runner,
// flipping every other spec into native-host mode (panel ripple → mass failures).

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = path.resolve(__dirname, 'fixtures', 'tabbar-app')
const PROBE_TITLE = 'C5-PROBE'

let electronApp: ElectronApplication
let mainWindow: PwPage
let autoPort = 0

// One-shot JSON-RPC call to the miniprogram-automator WebSocket server. Drives
// the SAME automation handlers the SDK uses, so it exercises the native-host
// automation pipeline (App.callWxMethod → service-host wx.*) end-to-end. Mirrors
// the helper in native-host-render.spec.ts / automator-compat.spec.ts. Note:
// rejects on an RPC-level error (e.g. "wx.X is not a function").
function wsCall<T = Record<string, unknown>>(
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 12000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${autoPort}`)
    const timer = setTimeout(() => { ws.close(); reject(new Error(`wsCall ${method} timed out`)) }, timeoutMs)
    ws.on('open', () => ws.send(JSON.stringify({ id: 'nhwx1', method, params })))
    ws.on('message', (raw) => {
      let msg: { id?: string; result?: unknown; error?: { message?: string } }
      try { msg = JSON.parse(String(raw)) } catch { return }
      if (msg.id !== 'nhwx1') return
      clearTimeout(timer)
      ws.close()
      if (msg.error) reject(new Error(msg.error.message || 'rpc error'))
      else resolve(msg.result as T)
    })
    ws.on('error', (err) => { clearTimeout(timer); reject(err) })
  })
}

async function navBarTitle(): Promise<string> {
  return evalInSimulator<string>(
    electronApp,
    `(() => { const e = document.querySelector('.nav-bar__title-text'); return e ? (e.textContent || '') : '' })()`,
  ).catch(() => '')
}

test.describe('native-host App.callWxMethod (non-nav) e2e', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(180_000)

  test.beforeAll(async () => {
    const appPath = path.resolve(__dirname, 'electron-entry.js')
    const userDataDir = path.resolve(
      process.env.DIMINA_DEVTOOLS_DATA_DIR
        ?? path.resolve(__dirname, '..', 'node_modules', '.cache', 'devtools-e2e'),
      'userdata',
      `nh-wxmethod-${process.pid}`,
    )
    fs.mkdirSync(userDataDir, { recursive: true })

    electronApp = await _electron.launch({
      args: [appPath, 'auto', '--auto-port', '0', `--user-data-dir=${userDataDir}`],
      env: { ...process.env, NODE_ENV: 'test', DIMINA_NATIVE_HOST: '1', DIMINA_E2E_USER_DATA_DIR: userDataDir },
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

    autoPort = await pollUntil(
      () => ipcInvoke<number | null>(mainWindow, AutomationChannel.GetPort),
      (val) => typeof val === 'number' && val > 0,
      10000,
      100,
    ) as number

    await openProjectInUI(mainWindow, FIXTURE_DIR, { waitMs: 20000 })
    await waitForSimulatorWebview(electronApp)
  })

  test.afterAll(async () => {
    await closeProject(mainWindow).catch(() => {})
    await electronApp?.close().catch(() => {})
  })

  test('App.callWxMethod setNavigationBarTitle updates the DeviceShell nav bar (service-host wx.*)', async () => {
    // Gate on the native render path being live (DeviceShell mounted), same as
    // the sibling render spec: this proves the service host + automation
    // pipeline are up before we drive the RPC.
    const shellMounted = await pollUntil(
      () => evalInSimulator<boolean>(
        electronApp,
        `(() => !!document.querySelector('.device-shell-root'))()`,
      ).catch(() => false),
      (ok) => ok === true,
      25000,
      300,
    )
    expect(shellMounted, 'DeviceShell .device-shell-root should mount under DIMINA_NATIVE_HOST=1').toBe(true)

    // Baseline: the default nav bar renders the fixture's configured title and is
    // not already our probe value (so the post-call assertion is meaningful).
    const before = await pollUntil(
      () => navBarTitle(),
      (t) => typeof t === 'string' && t.length > 0,
      25000,
      300,
    )
    expect(before, 'nav-bar title should render the fixture default before the call').toBe('TabBar Fixture')
    expect(before, 'baseline title must differ from the probe value').not.toBe(PROBE_TITLE)

    // The contract under test: a NON-navigation wx method invoked via
    // App.callWxMethod must run on the running mini-app's authoritative
    // (service-host) `wx`, so its UI effect is real. Under native-host today
    // this REJECTS ("wx.setNavigationBarTitle is not a function") because the
    // call lands on the simulator top-window `wx`, which lacks this method.
    await wsCall('App.callWxMethod', { method: 'setNavigationBarTitle', args: [{ title: PROBE_TITLE }] })

    // The effect flows service-host wx → DeviceShell nav-bar reducer → DOM.
    const after = await pollUntil(
      () => navBarTitle(),
      (t) => t === PROBE_TITLE,
      15000,
      400,
    )
    expect(after, `DeviceShell nav-bar title should update to ${PROBE_TITLE} via service-host wx`).toBe(PROBE_TITLE)
  })
})
