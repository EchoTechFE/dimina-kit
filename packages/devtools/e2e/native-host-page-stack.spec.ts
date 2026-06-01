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
 * Today under DIMINA_NATIVE_HOST=1 `App.getPageStack` only ever synthesises a
 * single-entry stack for the visible render-host page, so after two navigateTo
 * pushes it returns length 1 instead of 3 — this spec is RED until the
 * native-host page-stack tracking is fixed.
 *
 * Drives the SAME miniprogram-automator WebSocket surface the other
 * native-host specs use (`App.callWxMethod` for nav, `App.getCurrentPage` /
 * `App.getPageStack` for reads). Launch + project-open + DeviceShell-mount
 * wait mirror `native-host-render.spec.ts`.
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

// Routes (paths as the runtime reports them — no leading slash, see
// native-host-render.spec.ts which asserts App.getCurrentPage with .toContain('pages/')).
const ENTRY_ROUTE = 'pages/home/home'
const NAV_TARGET = 'pages/detail/detail' // the only non-tab page in the fixture

let electronApp: ElectronApplication
let mainWindow: PwPage
let autoPort = 0

interface PageStackEntry { pageId?: number; path?: string; query?: Record<string, unknown> }
interface PageStackResult { pageStack?: PageStackEntry[] }

// One-shot JSON-RPC call to the miniprogram-automator WebSocket server. Mirrors
// the helper in native-host-render.spec.ts so it drives the SAME native-host
// automation handlers end-to-end.
function wsCall<T = Record<string, unknown>>(
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 12000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${autoPort}`)
    const timer = setTimeout(() => { ws.close(); reject(new Error(`wsCall ${method} timed out`)) }, timeoutMs)
    ws.on('open', () => ws.send(JSON.stringify({ id: 'nhps1', method, params })))
    ws.on('message', (raw) => {
      let msg: { id?: string; result?: unknown; error?: { message?: string } }
      try { msg = JSON.parse(String(raw)) } catch { return }
      if (msg.id !== 'nhps1') return
      clearTimeout(timer)
      ws.close()
      if (msg.error) reject(new Error(msg.error.message || 'rpc error'))
      else resolve(msg.result as T)
    })
    ws.on('error', (err) => { clearTimeout(timer); reject(err) })
  })
}

async function getStack(): Promise<PageStackEntry[]> {
  const res = await wsCall<PageStackResult>('App.getPageStack')
  return Array.isArray(res.pageStack) ? res.pageStack : []
}

function topPath(stack: PageStackEntry[]): string {
  return stack.length ? String(stack[stack.length - 1]?.path ?? '') : ''
}

test.describe('native-host App.getPageStack tracks full in-app navigation stack', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(180_000)

  test.beforeAll(async () => {
    const appPath = path.resolve(__dirname, 'electron-entry.js')
    const userDataDir = path.resolve(
      process.env.DIMINA_DEVTOOLS_DATA_DIR
        ?? path.resolve(__dirname, '..', 'node_modules', '.cache', 'devtools-e2e'),
      'userdata',
      `nh-page-stack-${process.pid}`,
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
    await closeProject(mainWindow).catch(() => {})
    await electronApp?.close().catch(() => {})
  })

  test('two navigateTo pushes grow the stack to 3 (bottom→top), navigateBack shrinks to 2', async () => {
    // ── Entry: the active page is the entry route, stack has exactly 1 entry. ──
    const cur = await pollUntil(
      () => wsCall<{ path?: string }>('App.getCurrentPage').catch(() => null),
      (r) => !!r && typeof r.path === 'string' && r.path.includes('pages/'),
      20000,
      500,
    )
    expect(cur?.path, 'entry active page should be the fixture entry route').toContain(ENTRY_ROUTE)

    const entryStack = await pollUntil(
      () => getStack().catch(() => [] as PageStackEntry[]),
      (s) => s.length >= 1,
      20000,
      500,
    )
    expect(entryStack.length, 'entry page stack should have exactly 1 entry').toBe(1)
    expect(topPath(entryStack), 'the sole entry should be the entry route').toContain(ENTRY_ROUTE)

    // ── navigateTo #1 → stack length 2, top = NAV_TARGET ───────────────────────
    await wsCall('App.callWxMethod', { method: 'navigateTo', args: [{ url: '/' + NAV_TARGET }] })

    const afterPush1 = await pollUntil(
      () => getStack().catch(() => [] as PageStackEntry[]),
      (s) => topPath(s).includes(NAV_TARGET),
      15000,
      500,
    )
    expect(afterPush1.length, 'after navigateTo #1 the stack should have 2 entries').toBe(2)
    expect(topPath(afterPush1), 'top of the stack should be the navigated target').toContain(NAV_TARGET)
    // bottom→top order: the entry route must still sit at the bottom.
    expect(String(afterPush1[0]?.path ?? ''), 'bottom of the stack should still be the entry route').toContain(ENTRY_ROUTE)

    // ── navigateTo #2 → stack length 3, top = NAV_TARGET ───────────────────────
    await wsCall('App.callWxMethod', { method: 'navigateTo', args: [{ url: '/' + NAV_TARGET }] })

    const afterPush2 = await pollUntil(
      () => getStack().catch(() => [] as PageStackEntry[]),
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
    await wsCall('App.callWxMethod', { method: 'navigateBack', args: [{ delta: 1 }] })

    const afterBack = await pollUntil(
      () => getStack().catch(() => [] as PageStackEntry[]),
      (s) => s.length <= 2,
      15000,
      500,
    )
    expect(afterBack.length, 'after navigateBack the stack should shrink to 2 entries').toBe(2)
    expect(topPath(afterBack), 'top of the post-back stack should still be the navigated target').toContain(NAV_TARGET)
    expect(String(afterBack[0]?.path ?? ''), 'bottom should remain the entry route').toContain(ENTRY_ROUTE)
  })
})
