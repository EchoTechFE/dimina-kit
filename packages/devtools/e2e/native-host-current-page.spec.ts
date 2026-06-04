/**
 * E2E (native-host only): the devtools main-window simulator-panel bottom
 * toolbar's CURRENT-PAGE path display must UPDATE when the mini-app navigates
 * to a different page.
 *
 * Contract being pinned:
 *   Under DIMINA_NATIVE_HOST=1 the mini-app renders in a main-process
 *   DeviceShell / render-host <webview>s. The simulator-panel toolbar shows the
 *   route of the visible top-of-stack page plus a "复制路径" button. When the
 *   app navigates (wx.navigateTo / switchTab / navigateBack) the toolbar text
 *   must reflect the now-visible page's route — not stay stuck on the entry
 *   page it was seeded with from the launch URL.
 *
 * Fixture: e2e/fixtures/tabbar-app
 *   - app.json `pages[0]` = "pages/home/home"  → entry / launch route.
 *   - "pages/detail/detail" is a distinct, non-tab page reachable via
 *     wx.navigateTo({ url: '/pages/detail/detail' }) — its route differs from
 *     the entry, so it is an unambiguous "did the toolbar update?" signal.
 *
 * Today (current code) this FAILS: under native-host the toolbar path is seeded
 * from the initial launch URL and never updates on in-app navigation, so after
 * navigating it remains the entry route (pages/home/home).
 *
 * The toolbar text is read from the main window's DOM (the simulator-panel is a
 * renderer React component): the bottom toolbar (`.bg-sim-bottom`) contains a
 * `<span>` with the current page text followed by the `title="复制路径"`
 * button — see
 * src/renderer/modules/main/features/project-runtime/components/simulator-panel.tsx.
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

// Entry (launch) route: app.json `pages[0]`. Navigation target: a distinct,
// non-tab page reachable via wx.navigateTo. These routes differ, so a toolbar
// that still shows ENTRY_ROUTE after navigating to TARGET_ROUTE proves the bug.
const ENTRY_ROUTE = 'pages/home/home'
const TARGET_ROUTE = 'pages/detail/detail'

let electronApp: ElectronApplication
let mainWindow: PwPage
let autoPort = 0

// One-shot JSON-RPC call to the miniprogram-automator WebSocket server (mirrors
// native-host-render.spec.ts). Drives the SAME automation handlers the SDK
// uses, exercising the native-host nav pipeline end-to-end (App.callWxMethod →
// serviceWc wx.*).
function wsCall<T = Record<string, unknown>>(
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 12000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${autoPort}`)
    const timer = setTimeout(() => { ws.close(); reject(new Error(`wsCall ${method} timed out`)) }, timeoutMs)
    ws.on('open', () => ws.send(JSON.stringify({ id: 'cp1', method, params })))
    ws.on('message', (raw) => {
      let msg: { id?: string; result?: unknown; error?: { message?: string } }
      try { msg = JSON.parse(String(raw)) } catch { return }
      if (msg.id !== 'cp1') return
      clearTimeout(timer)
      ws.close()
      if (msg.error) reject(new Error(msg.error.message || 'rpc error'))
      else resolve(msg.result as T)
    })
    ws.on('error', (err) => { clearTimeout(timer); reject(err) })
  })
}

/**
 * Read the simulator-panel bottom-toolbar current-page text from the MAIN
 * window DOM. The toolbar is `.bg-sim-bottom` (see simulator-panel.tsx); the
 * route lives in its first text-bearing span, directly before the
 * `title="复制路径"` copy button. We read that span's textContent and trim it.
 * Returns '' if the toolbar isn't present yet.
 */
async function readToolbarCurrentPage(win: PwPage): Promise<string> {
  return win.evaluate(() => {
    const toolbar = document.querySelector('.bg-sim-bottom')
    if (!toolbar) return ''
    const span = toolbar.querySelector('span')
    const txt = (span?.textContent ?? '').trim()
    // The placeholder when there is no current page is an em dash.
    return txt === '—' ? '' : txt
  })
}

test.describe('native-host current-page toolbar e2e', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(180_000)

  test.beforeAll(async () => {
    const appPath = path.resolve(__dirname, 'electron-entry.js')
    const userDataDir = path.resolve(
      process.env.DIMINA_DEVTOOLS_DATA_DIR
        ?? path.resolve(__dirname, '..', 'node_modules', '.cache', 'devtools-e2e'),
      'userdata',
      `nh-current-page-${process.pid}`,
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

    // DeviceShell mounts only after SimulatorMiniApp.spawn() resolves; poll for
    // its root the same way native-host-render.spec.ts does so the entry page is
    // actually rendered before we read the toolbar.
    await pollUntil(
      () => evalInSimulator<boolean>(
        electronApp,
        `(() => !!document.querySelector('.device-shell-root'))()`,
      ).catch(() => false),
      (ok) => ok === true,
      25000,
      300,
    )
  })

  test.afterAll(async () => {
    await closeProject(mainWindow).catch(() => {})
    await electronApp?.close().catch(() => {})
  })

  test('toolbar current-page path updates after wx.navigateTo under native-host', async () => {
    // ── Sanity: automation reports the entry page, so the app is actually on
    // the launch route before we navigate. ──────────────────────────────────
    const cur = await pollUntil(
      () => wsCall<{ path?: string }>('App.getCurrentPage').catch(() => null),
      (r) => !!r && typeof r.path === 'string' && r.path.includes(ENTRY_ROUTE),
      20000,
      500,
    )
    expect(cur?.path, 'app should start on the entry route').toContain(ENTRY_ROUTE)

    // ── BEFORE: the toolbar shows the entry route. ───────────────────────────
    const before = await pollUntil(
      () => readToolbarCurrentPage(mainWindow),
      (txt) => txt.includes(ENTRY_ROUTE),
      20000,
      400,
    )
    expect(before, 'toolbar should show the entry route before navigation').toContain(ENTRY_ROUTE)

    // ── NAVIGATE: wx.navigateTo to a DIFFERENT, non-tab page. This routes
    // through the native-host service-host wx.* the same way the render spec's
    // switchTab does, and lands the visible top-of-stack page on TARGET_ROUTE. ─
    await wsCall('App.callWxMethod', { method: 'navigateTo', args: [{ url: '/' + TARGET_ROUTE }] })

    // Confirm via automation that the active page actually moved (decouples a
    // toolbar-update failure from a navigation failure).
    const moved = await pollUntil(
      () => wsCall<{ path?: string }>('App.getCurrentPage').catch(() => null),
      (r) => !!r && typeof r.path === 'string' && r.path.includes(TARGET_ROUTE),
      15000,
      500,
    )
    expect(moved?.path, `navigateTo should move the active page to ${TARGET_ROUTE}`).toContain(TARGET_ROUTE)

    // ── AFTER: the toolbar current-page text must have UPDATED to the new
    // route and must no longer be the entry route. THIS is the contract that
    // current code violates under native-host. ──────────────────────────────
    const after = await pollUntil(
      () => readToolbarCurrentPage(mainWindow),
      (txt) => txt.includes(TARGET_ROUTE),
      15000,
      400,
    )
    expect(
      after,
      `after navigateTo the toolbar should show ${TARGET_ROUTE} (was "${before}")`,
    ).toContain(TARGET_ROUTE)
    expect(
      after.includes(ENTRY_ROUTE),
      `toolbar should no longer show the entry route ${ENTRY_ROUTE} after navigation (got "${after}")`,
    ).toBe(false)
  })
})
