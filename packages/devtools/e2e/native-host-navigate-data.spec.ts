/**
 * E2E (native-host only): a page opened via `wx.navigateTo` (a NON-root, non-tab
 * page) must end up with a MOUNTED service instance — i.e. its declared default
 * `data` must be live in `ctx.appData` and readable via `Page.getData`.
 *
 * Bug pinned here (Bug-3, RED): under native-host, bridge-router only sends the
 * service-side `loadResource` (which registers a page's module) for the ROOT
 * (entry/tab) page. A navigateTo/redirectTo/reLaunch target only receives a
 * slimmed `resourceLoaded`, so the service's `getModuleByPath` can't find the
 * module ("module not found") → it never `createInstance` → no `onLoad`, no
 * initial data lands in `ctx.appData`. Result: `Page.getData` for the navigated
 * page is `{}`, and the AppData / WXML panels are empty for it. The root/tab
 * entry page is fine.
 *
 * Contract this test asserts:
 *   - Control (proves the entry/root path works): the entry page's
 *     `Page.getData` is non-empty (pages/home/home declares
 *     `{ pageName, counter, profile }`).
 *   - Target (currently FAILS): after `App.callWxMethod` navigateTo
 *     `/pages/detail/detail`, that page's `Page.getData` must contain the
 *     fixture's declared default data (`probeName === 'detail-probe'`,
 *     `count === 42`). Today it returns `{}`.
 *
 * `App.getCurrentPage` is polled between nav and the data read to DECOUPLE a
 * navigation failure (wrong/empty route) from the data-mount failure this test
 * targets: if routing is broken the test fails at the route assertion, not the
 * data one.
 *
 * Fixture note: `e2e/fixtures/tabbar-app/pages/detail/detail.js` was given a
 * declared `data: { probeName: 'detail-probe', count: 42 }` SOLELY so this test
 * has a stable non-empty default to assert against. That is a TEST fixture
 * change, NOT a product change.
 *
 * Launch + project-open + DeviceShell-mount wait + the WS JSON-RPC helper are
 * copied from native-host-page-stack.spec.ts so this drives the SAME native-host
 * automation handlers end-to-end.
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

// NOTE: DIMINA_NATIVE_HOST is scoped to THIS spec's electron launch (below),
// never `process.env` — mutating it at module top poisons the shared
// --workers=1 runner and flips every other spec into native-host mode.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = path.resolve(__dirname, 'fixtures', 'tabbar-app')

// Routes as the runtime reports them — no leading slash (see
// native-host-render.spec.ts, App.getCurrentPage .toContain('pages/')).
const ENTRY_ROUTE = 'pages/home/home'
const NAV_TARGET = 'pages/detail/detail' // the only non-tab page in the fixture

let electronApp: ElectronApplication
let mainWindow: PwPage
let autoPort = 0

// One-shot JSON-RPC call to the miniprogram-automator WebSocket server. Mirrors
// native-host-page-stack.spec.ts so it drives the SAME native-host handlers.
function wsCall<T = Record<string, unknown>>(
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 12000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${autoPort}`)
    const timer = setTimeout(() => { ws.close(); reject(new Error(`wsCall ${method} timed out`)) }, timeoutMs)
    ws.on('open', () => ws.send(JSON.stringify({ id: 'nhnd1', method, params })))
    ws.on('message', (raw) => {
      let msg: { id?: string; result?: unknown; error?: { message?: string } }
      try { msg = JSON.parse(String(raw)) } catch { return }
      if (msg.id !== 'nhnd1') return
      clearTimeout(timer)
      ws.close()
      if (msg.error) reject(new Error(msg.error.message || 'rpc error'))
      else resolve(msg.result as T)
    })
    ws.on('error', (err) => { clearTimeout(timer); reject(err) })
  })
}

async function getData(): Promise<Record<string, unknown>> {
  const res = await wsCall<{ data?: unknown }>('Page.getData')
  return (res && typeof res.data === 'object' && res.data !== null)
    ? (res.data as Record<string, unknown>)
    : {}
}

test.describe('native-host navigateTo target page gets a mounted service instance (initial data)', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(180_000)

  test.beforeAll(async () => {
    const appPath = path.resolve(__dirname, 'electron-entry.js')
    const userDataDir = path.resolve(
      process.env.DIMINA_DEVTOOLS_DATA_DIR
        ?? path.resolve(__dirname, '..', 'node_modules', '.cache', 'devtools-e2e'),
      'userdata',
      `nh-navigate-data-${process.pid}`,
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

    // DeviceShell mounts only after SimulatorMiniApp.spawn() resolves; the entry
    // render-host webview must exist before we drive navigation.
    await pollUntil(
      () => evalInSimulator<number>(
        electronApp,
        `(() => document.querySelectorAll('.device-shell__webview').length)()`,
      ).catch(() => 0),
      (n) => n >= 1,
      25000,
      300,
    )
  })

  test.afterAll(async () => {
    await closeProject(mainWindow).catch(() => {})
    await electronApp?.close().catch(() => {})
  })

  test('navigateTo target page Page.getData contains its declared default data', async () => {
    // ── Entry/root page is active and its data is non-empty (CONTROL). ─────────
    const cur = await pollUntil(
      () => wsCall<{ path?: string }>('App.getCurrentPage').catch(() => null),
      (r) => !!r && typeof r.path === 'string' && r.path.includes('pages/'),
      20000,
      500,
    )
    expect(cur?.path, 'entry active page should be the fixture entry route').toContain(ENTRY_ROUTE)

    // CONTROL: the root/tab entry page must have a mounted service instance, so
    // its declared default data is live. If THIS is empty the whole runtime is
    // broken and the target assertion below would be meaningless.
    const entryData = await pollUntil(
      () => getData().catch(() => ({} as Record<string, unknown>)),
      (d) => Object.keys(d).length > 0,
      20000,
      500,
    )
    expect(
      Object.keys(entryData).length,
      'CONTROL: entry (root) page Page.getData must be non-empty (declares pageName/counter/profile)',
    ).toBeGreaterThan(0)
    // pages/home/home declares { pageName: 'home', counter: 7, profile: {...} }.
    expect(entryData.pageName, 'CONTROL: entry page should expose its declared pageName').toBe('home')

    // ── navigateTo the NON-root target page. ───────────────────────────────────
    await wsCall('App.callWxMethod', { method: 'navigateTo', args: [{ url: '/' + NAV_TARGET }] })

    // DECOUPLE nav failure from data failure: confirm we actually routed to the
    // target before asserting on its data. If routing is broken this fails here.
    const afterNav = await pollUntil(
      () => wsCall<{ path?: string }>('App.getCurrentPage').catch(() => null),
      (r) => !!r && typeof r.path === 'string' && r.path.includes(NAV_TARGET),
      15000,
      500,
    )
    expect(afterNav?.path, 'after navigateTo the active page should be the target route').toContain(NAV_TARGET)

    // ── TARGET (currently RED): the navigateTo'd page must have a mounted ───────
    // service instance, so its declared default data is readable. Bug-3 makes
    // this return `{}` because the service never registered the page module and
    // never created the instance.
    const detailData = await pollUntil(
      () => getData().catch(() => ({} as Record<string, unknown>)),
      (d) => d.probeName === 'detail-probe',
      15000,
      500,
    )
    expect(
      detailData.probeName,
      'navigateTo target page Page.getData should contain its declared default data (Bug-3: returns {} because the non-root service instance never mounts)',
    ).toBe('detail-probe')
    expect(
      detailData.count,
      'navigateTo target page should also expose its declared `count`',
    ).toBe(42)
  })
})
