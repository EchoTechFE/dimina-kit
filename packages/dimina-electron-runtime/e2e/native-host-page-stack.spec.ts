/**
 * E2E (native-host only): `App.getPageStack` must reflect the FULL ordered
 * in-app navigation stack, not just the single visible page.
 *
 * Contract pinned here:
 *   - At entry the stack has the single entry page (length 1).
 *   - Each `wx.navigateTo` push grows the stack by one, ordered bottom→top, so
 *     after two pushes the stack has 3 entries and the top entry's `path`
 *     matches the most-recently-navigated route.
 *   - `wx.navigateBack` shrinks the stack back (length 3 → 2).
 *
 * This contract is satisfied (GREEN): DeviceShell tracks the per-tab full stack
 * (packages/dimina-electron-runtime/src/simulator-ui/page-stack-controller.ts) and reports it over the
 * PAGE_STACK channel; the bridge stores it (bridge-router.ts `ap.pageStack`) and
 * `getPageStack`/`callWxMethod` (electron-entry.js's `__diminaE2eHooks`, a
 * direct in-process port of devtools' automation handlers) read/drive it
 * without any WS/JSON-RPC layer — Playwright controls this same process.
 *
 * Fixture nav targets (e2e/fixtures/tabbar-app/app.json):
 *   - pages = home, cart, me, detail; tabBar.list = home, cart, me.
 *   - Entry page = pages/home/home (first in `pages`, a tab page).
 *   - The ONLY non-tab page reachable via `wx.navigateTo` is
 *     pages/detail/detail (navigateTo cannot target tab pages). So both pushes
 *     target pages/detail/detail. WeChat-style runtimes push a fresh page
 *     instance per navigateTo even to the same path (stack depth up to 10), so
 *     two pushes => a 3-deep stack [home, detail, detail].
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
  getPageStack,
  getCurrentPage,
  callWxMethod,
  type PageStackEntry,
} from './helpers'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = path.resolve(__dirname, 'fixtures', 'tabbar-app')

// Routes (paths as the runtime reports them — no leading slash).
const ENTRY_ROUTE = 'pages/home/home'
const NAV_TARGET = 'pages/detail/detail' // the only non-tab page in the fixture

let electronApp: ElectronApplication
let mainWindow: PwPage

function topPath(stack: PageStackEntry[]): string {
  return stack.length ? stack[stack.length - 1]?.path ?? '' : ''
}

test.describe('native-host App.getPageStack tracks full in-app navigation stack', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(180_000)

  test.beforeAll(async () => {
    const appPath = path.resolve(__dirname, 'electron-entry.js')
    const userDataDir = path.resolve(
      process.env.DIMINA_DEVTOOLS_DATA_DIR
        ?? path.resolve(__dirname, '..', 'node_modules', '.cache', 'electron-runtime-e2e'),
      'userdata',
      `nh-page-stack-${process.pid}`,
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
    // render-host webview must exist before we start driving navigation.
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
    await closeProject(electronApp).catch(() => {})
    await electronApp?.close().catch(() => {})
  })

  test('two navigateTo pushes grow the stack to 3 (bottom→top), navigateBack shrinks to 2', async () => {
    // ── Entry: the active page is the entry route, stack has exactly 1 entry. ──
    // These queries only read main's ledger, and `pollUntil` already swallows a
    // failed round-trip and polls again — which is what absorbs the occasional
    // CDP "Script failed to execute" a full-suite run produces (see helpers.ts
    // on why the NAV calls must NOT be retried the same way). Catching here
    // instead would hand the predicate a fabricated value and consume the very
    // attempt the retry exists for.
    const cur = await pollUntil(
      () => getCurrentPage(electronApp),
      (r) => !!r && typeof r.path === 'string' && r.path.includes('pages/'),
      20000,
      500,
    )
    expect(cur?.path, 'entry active page should be the fixture entry route').toContain(ENTRY_ROUTE)

    const entryStack = await pollUntil(
      () => getPageStack(electronApp),
      (s) => s.length >= 1,
      20000,
      500,
    )
    expect(entryStack.length, 'entry page stack should have exactly 1 entry').toBe(1)
    expect(topPath(entryStack), 'the sole entry should be the entry route').toContain(ENTRY_ROUTE)

    // ── navigateTo #1 → stack length 2, top = NAV_TARGET ───────────────────────
    await callWxMethod(electronApp, 'navigateTo', [{ url: '/' + NAV_TARGET }])

    const afterPush1 = await pollUntil(
      () => getPageStack(electronApp),
      (s) => topPath(s).includes(NAV_TARGET),
      15000,
      500,
    )
    expect(afterPush1.length, 'after navigateTo #1 the stack should have 2 entries').toBe(2)
    expect(topPath(afterPush1), 'top of the stack should be the navigated target').toContain(NAV_TARGET)
    // bottom→top order: the entry route must still sit at the bottom.
    expect(String(afterPush1[0]?.path ?? ''), 'bottom of the stack should still be the entry route').toContain(ENTRY_ROUTE)

    // ── navigateTo #2 → stack length 3, top = NAV_TARGET ───────────────────────
    await callWxMethod(electronApp, 'navigateTo', [{ url: '/' + NAV_TARGET }])

    const afterPush2 = await pollUntil(
      () => getPageStack(electronApp),
      (s) => s.length >= 3,
      15000,
      500,
    )
    expect(
      afterPush2.length,
      'after two navigateTo pushes App.getPageStack should report 3 entries (entry + 2)',
    ).toBe(3)
    expect(topPath(afterPush2), 'top of the 3-deep stack should be the last navigated route').toContain(NAV_TARGET)
    // bottom→top order: [entry, NAV_TARGET, NAV_TARGET].
    expect(String(afterPush2[0]?.path ?? ''), 'stack[0] (bottom) should be the entry route').toContain(ENTRY_ROUTE)
    expect(String(afterPush2[1]?.path ?? ''), 'stack[1] should be the first pushed route').toContain(NAV_TARGET)

    // ── navigateBack → stack length 2 ──────────────────────────────────────────
    await callWxMethod(electronApp, 'navigateBack', [{ delta: 1 }])

    // `=== 2`, not `<= 2`: the stack starts at 3 and only shrinking to exactly
    // 2 is the state under test, so a shorter reading is never the answer —
    // it means something went wrong, and waiting it out reports that as a
    // timeout carrying the real error instead of as a bogus assertion value.
    const afterBack = await pollUntil(
      () => getPageStack(electronApp),
      (s) => s.length === 2,
      15000,
      500,
    )
    expect(afterBack.length, 'after navigateBack the stack should shrink to 2 entries').toBe(2)
    expect(topPath(afterBack), 'top of the post-back stack should still be the navigated target').toContain(NAV_TARGET)
    expect(String(afterBack[0]?.path ?? ''), 'bottom should remain the entry route').toContain(ENTRY_ROUTE)
  })
})
