/**
 * E2E (native-host): the simulator nav-bar HOME button, switchTab branch.
 *
 * WeChat parity contract: the home button shows exactly when the current
 * page is neither the app's home page (entryPagePath, default `pages[0]`)
 * nor a tabBar page, and the page is either at the bottom of the page stack
 * or opts in via its own page-config `homeButton: true`. Tapping it always
 * ends on the home page; when the home page is itself a tabBar page the
 * transition is a `switchTab`.
 *
 * demo-app's entry page (`pages/index/index`) is itself a tabBar page, so
 * this file exercises the switchTab branch plus the tabBar-adjacent
 * exclusions (no home button on the home page itself, none on a tabBar
 * page). The redirectTo / reLaunch branches and the back-arrow + home-button
 * coexistence case need an app whose home page is NOT a tab, so those live
 * in home-button-no-tabbar.spec.ts against a dedicated fixture.
 *
 * DOM contract (see src/simulator/device-shell/navigation-bar.tsx and
 * tab-bar.tsx): home button is `.nav-bar__home`, back arrow is
 * `.nav-bar__back`, the tabBar is `.dmb-tab-bar`. All three live inside the
 * native-host device shell (`.device-shell-root`), which only mounts under
 * DIMINA_NATIVE_HOST=1 — the legacy non-native-host renderer draws its own
 * nav chrome inside the mini-app's own webview and does not have this
 * feature.
 */
import { test, expect, _electron, type ElectronApplication, type Page as PwPage } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { WebSocket } from 'ws'
import {
  DEMO_APP_DIR,
  addProject,
  openProjectInUI,
  waitForSimulatorWebview,
  closeProject,
  ipcInvoke,
  pollUntil,
  evalInSimulator,
} from './helpers'
import { AutomationChannel, ProjectChannel } from '../src/shared/ipc-channels'
import { DEFAULT_SCENE } from '../src/shared/constants'

// NOTE: scope DIMINA_NATIVE_HOST to THIS spec's electron launch (below), never
// `process.env` — a module-top mutation poisons the shared --workers=1 runner,
// flipping every other spec into native-host mode.

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const INDEX_PAGE = 'pages/index/index'
const CONSOLE_TEST_PAGE = 'pages/console-test/console-test'
const TABBAR_ME_PAGE = 'pages/tabbar-me/tabbar-me'

let electronApp: ElectronApplication
let mainWindow: PwPage
let autoPort = 0

function wsCall<T = Record<string, unknown>>(
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 12000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${autoPort}`)
    const timer = setTimeout(() => { ws.close(); reject(new Error(`wsCall ${method} timed out`)) }, timeoutMs)
    ws.on('open', () => ws.send(JSON.stringify({ id: 'hb1', method, params })))
    ws.on('message', (raw) => {
      let msg: { id?: string; result?: unknown; error?: { message?: string } }
      try { msg = JSON.parse(String(raw)) } catch { return }
      if (msg.id !== 'hb1') return
      clearTimeout(timer)
      ws.close()
      if (msg.error) reject(new Error(msg.error.message || 'rpc error'))
      else resolve(msg.result as T)
    })
    ws.on('error', (err) => { clearTimeout(timer); reject(err) })
  })
}

interface NavBarSnapshot {
  hasHome: boolean
  hasBack: boolean
  hasTabBar: boolean
}

/** Read the nav-bar/tabBar DOM contract from the active DeviceShell in one round trip. */
async function readNavBarSnapshot(): Promise<NavBarSnapshot> {
  return evalInSimulator<NavBarSnapshot>(
    electronApp,
    `(() => ({
      hasHome: !!document.querySelector('.nav-bar__home'),
      hasBack: !!document.querySelector('.nav-bar__back'),
      hasTabBar: !!document.querySelector('.dmb-tab-bar'),
    }))()`,
  )
}

/** Click the nav-bar home button inside the active DeviceShell. Returns false if absent. */
async function clickHomeButton(): Promise<boolean> {
  return evalInSimulator<boolean>(
    electronApp,
    `(() => {
      const btn = document.querySelector('.nav-bar__home')
      if (!btn) return false
      btn.click()
      return true
    })()`,
  )
}

/**
 * Close any open project, point demo-app's compile config at `startPage`,
 * then reopen so the fresh session launches directly on that page. Compile
 * config is scoped to THIS spec's private `--user-data-dir`, so it never
 * leaks into the shared worker-scoped Electron instance other specs use.
 */
async function openDemoAppAt(startPage: string): Promise<void> {
  await closeProject(mainWindow).catch(() => {})
  await addProject(mainWindow, DEMO_APP_DIR)
  await ipcInvoke(mainWindow, ProjectChannel.SaveCompileConfig, DEMO_APP_DIR, {
    startPage,
    scene: DEFAULT_SCENE,
    queryParams: [],
  })
  await openProjectInUI(mainWindow, DEMO_APP_DIR, { waitMs: 20000 })
  await waitForSimulatorWebview(electronApp)
  await pollUntil(
    () => evalInSimulator<boolean>(electronApp, `(() => !!document.querySelector('.device-shell-root'))()`).catch(() => false),
    (ok) => ok === true,
    25000,
    300,
  )
  await pollUntil(
    () => wsCall<{ path?: string }>('App.getCurrentPage').catch(() => null),
    (r) => !!r && typeof r.path === 'string' && r.path.includes(startPage),
    20000,
    500,
  )
}

test.describe('native-host nav-bar home button (switchTab branch)', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(120_000)

  test.beforeAll(async () => {
    const appPath = path.resolve(__dirname, 'electron-entry.js')
    const userDataDir = path.resolve(
      process.env.DIMINA_DEVTOOLS_DATA_DIR
        ?? path.resolve(__dirname, '..', 'node_modules', '.cache', 'devtools-e2e'),
      'userdata',
      `nh-home-button-${process.pid}`,
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
  })

  test.afterAll(async () => {
    await closeProject(mainWindow).catch(() => {})
    await electronApp?.close().catch(() => {})
  })

  test('non-home, non-tab page at stack bottom shows the home button with no back arrow; tapping it switchTabs home', async () => {
    await openDemoAppAt(CONSOLE_TEST_PAGE)

    const before = await readNavBarSnapshot()
    expect(before.hasHome, 'a non-home, non-tab page at stack bottom should show the home button').toBe(true)
    expect(before.hasBack, 'stack-bottom page has no prior page to go back to').toBe(false)
    expect(before.hasTabBar, 'a non-tab page must not render the tabBar').toBe(false)

    const clicked = await clickHomeButton()
    expect(clicked, 'the home button must be clickable').toBe(true)

    const moved = await pollUntil(
      () => wsCall<{ path?: string }>('App.getCurrentPage').catch(() => null),
      (r) => !!r && typeof r.path === 'string' && r.path.includes(INDEX_PAGE),
      15000,
      400,
    )
    expect(moved?.path, 'home\'s tabBar target should switchTab to the app home page').toContain(INDEX_PAGE)

    const stack = await wsCall<{ pageStack?: Array<{ path: string }> }>('App.getPageStack')
    expect(stack.pageStack?.length, 'switchTab must leave exactly the home page on the stack').toBe(1)

    const after = await readNavBarSnapshot()
    expect(after.hasHome, 'the home button must disappear once on the home page').toBe(false)
    expect(after.hasTabBar, 'the app home page is a tabBar page, so the tabBar must show').toBe(true)
  })

  test('tabBar page never shows the home button, even though it is not the home page', async () => {
    await openDemoAppAt(TABBAR_ME_PAGE)

    const snap = await readNavBarSnapshot()
    expect(snap.hasHome, 'a tabBar page must never show the home button').toBe(false)
    expect(snap.hasBack, 'a tabBar page is never navigated to via navigateTo, so it has no back arrow').toBe(false)
    expect(snap.hasTabBar, 'a tabBar page must render the tabBar').toBe(true)
  })

  test('the app home page itself never shows the home button', async () => {
    await openDemoAppAt(INDEX_PAGE)

    const snap = await readNavBarSnapshot()
    expect(snap.hasHome, 'the home page must not offer a button back to itself').toBe(false)
    expect(snap.hasTabBar, 'demo-app\'s home page is also its tabBar entry, so the tabBar must show').toBe(true)
  })
})
