/**
 * E2E (native-host only): a page opened via `wx.navigateTo` (a NON-root, non-tab
 * page) must end up with a MOUNTED service instance — i.e. its declared default
 * `data` must be live in `ctx.appData` and readable via `getPageData`.
 *
 * Bug pinned here (Bug-3, RED): under native-host, bridge-router only sends the
 * service-side `loadResource` (which registers a page's module) for the ROOT
 * (entry/tab) page. A navigateTo/redirectTo/reLaunch target only receives a
 * slimmed `resourceLoaded`, so the service's `getModuleByPath` can't find the
 * module ("module not found") → it never `createInstance` → no `onLoad`, no
 * initial data lands in `ctx.appData`. Result: `getPageData` for the navigated
 * page is `{}`, and the AppData / WXML panels are empty for it. The root/tab
 * entry page is fine.
 *
 * Contract this test asserts:
 *   - Control (proves the entry/root path works): the entry page's
 *     `getPageData` is non-empty (pages/home/home declares
 *     `{ pageName, counter, profile }`).
 *   - Target (currently FAILS): after `callWxMethod` navigateTo
 *     `/pages/detail/detail`, that page's `getPageData` must contain the
 *     fixture's declared default data (`probeName === 'detail-probe'`,
 *     `count === 42`). Today it returns `{}`.
 *
 * `getCurrentPage` is polled between nav and the data read to DECOUPLE a
 * navigation failure (wrong/empty route) from the data-mount failure this test
 * targets: if routing is broken the test fails at the route assertion, not the
 * data one.
 *
 * Fixture note: `e2e/fixtures/tabbar-app/pages/detail/detail.js` was given a
 * declared `data: { probeName: 'detail-probe', count: 42 }` SOLELY so this test
 * has a stable non-empty default to assert against. That is a TEST fixture
 * change, NOT a product change.
 *
 * Launch + project-open + DeviceShell-mount wait are copied from
 * native-host-page-stack.spec.ts so this drives the SAME native-host
 * introspection/automation hooks end-to-end.
 */
import { test, expect, _electron, type ElectronApplication, type Page as PwPage } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import {
  openProject,
  waitForSimulatorWebview,
  closeProject,
  pollUntil,
  evalInSimulator,
  getCurrentPage,
  getPageData,
  callWxMethod,
  waitForServicePageReady,
} from './helpers'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = path.resolve(__dirname, 'fixtures', 'tabbar-app')
const APP_ID = 'devtools_tabbar_fixture' // tabbar-app/project.config.json appid

// Routes as the runtime reports them — no leading slash (see
// native-host-render.spec.ts, getCurrentPage .toContain('pages/')).
const ENTRY_ROUTE = 'pages/home/home'
const NAV_TARGET = 'pages/detail/detail' // the only non-tab page in the fixture

let electronApp: ElectronApplication
let mainWindow: PwPage

async function getData(): Promise<Record<string, unknown>> {
  const data = await getPageData(electronApp, APP_ID)
  return (data && typeof data === 'object')
    ? (data as Record<string, unknown>)
    : {}
}

test.describe('native-host navigateTo target page gets a mounted service instance (initial data)', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(180_000)

  test.beforeAll(async () => {
    const appPath = path.resolve(__dirname, 'electron-entry.js')
    const userDataDir = path.resolve(
      process.env.DIMINA_DEVTOOLS_DATA_DIR
        ?? path.resolve(__dirname, '..', 'node_modules', '.cache', 'electron-runtime-e2e'),
      'userdata',
      `nh-navigate-data-${process.pid}`,
    )
    fs.mkdirSync(userDataDir, { recursive: true })

    electronApp = await _electron.launch({
      args: [appPath, `--user-data-dir=${userDataDir}`],
      env: { ...process.env, NODE_ENV: 'test', DIMINA_E2E_USER_DATA_DIR: userDataDir },
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

    await openProject(electronApp, FIXTURE_DIR)
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
    // The route APIs resolve against the SERVICE host's own page stack, which is still empty for a few hundred ms after the render guest mounts.
    // Navigating inside that window throws in the mini-app framework.
    await waitForServicePageReady(electronApp)
  })

  test.afterAll(async () => {
    await closeProject(electronApp).catch(() => {})
    await electronApp?.close().catch(() => {})
  })

  test('navigateTo target page getPageData contains its declared default data', async () => {
    // ── Entry/root page is active and its data is non-empty (CONTROL). ─────────
    const cur = await pollUntil(
      () => getCurrentPage(electronApp).catch(() => null),
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
      'CONTROL: entry (root) page getPageData must be non-empty (declares pageName/counter/profile)',
    ).toBeGreaterThan(0)
    // pages/home/home declares { pageName: 'home', counter: 7, profile: {...} }.
    expect(entryData.pageName, 'CONTROL: entry page should expose its declared pageName').toBe('home')

    // ── navigateTo the NON-root target page. ───────────────────────────────────
    await callWxMethod(electronApp, 'navigateTo', [{ url: '/' + NAV_TARGET }])

    // DECOUPLE nav failure from data failure: confirm we actually routed to the
    // target before asserting on its data. If routing is broken this fails here.
    const afterNav = await pollUntil(
      () => getCurrentPage(electronApp).catch(() => null),
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
      'navigateTo target page getPageData should contain its declared default data (Bug-3: returns {} because the non-root service instance never mounts)',
    ).toBe('detail-probe')
    expect(
      detailData.count,
      'navigateTo target page should also expose its declared `count`',
    ).toBe(42)
  })
})
