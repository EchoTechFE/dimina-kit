/**
 * E2E (native-host): the simulator nav-bar HOME button, redirectTo/reLaunch
 * branches and the back-arrow + home-button coexistence case.
 *
 * WeChat parity contract: the home button shows exactly when the current
 * page is neither the app's home page nor a tabBar page, and the page is
 * either at the bottom of the page stack or opts in via its own page-config
 * `homeButton: true`. Tapping it always ends on the home page: redirectTo
 * when home is a non-tab page and the current page is stack-bottom, reLaunch
 * otherwise (e.g. a deeper page that opted in via `homeButton: true`) — see
 * home-button.spec.ts for the switchTab branch, which needs a tabBar home
 * page instead.
 *
 * Fixture: e2e/fixtures/home-button-app — deliberately has NO tabBar, so its
 * home page (`pages/home/home`) is a plain page and the redirectTo/reLaunch
 * branches are actually reachable:
 *   - `pages/inner/inner` — a stack-bottom, non-home page with no
 *     `homeButton` override, reachable by launching directly on it.
 *   - `pages/forced/forced` — reachable only via `wx.navigateTo` from
 *     `pages/inner/inner` (so it's never stack-bottom) and declares
 *     `homeButton: true` in its own page config.
 *
 * DOM contract: home button `.nav-bar__home`, back arrow `.nav-bar__back`
 * (see src/simulator/device-shell/navigation-bar.tsx), both inside the
 * native-host device shell (`.device-shell-root`, DIMINA_NATIVE_HOST=1 only).
 */
import { test, expect, _electron, type ElectronApplication, type Page as PwPage } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { WebSocket } from 'ws'
import {
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
const FIXTURE_DIR = path.resolve(__dirname, 'fixtures', 'home-button-app')

const HOME_PAGE = 'pages/home/home'
const INNER_PAGE = 'pages/inner/inner'
const FORCED_PAGE = 'pages/forced/forced'

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
    ws.on('open', () => ws.send(JSON.stringify({ id: 'hbn1', method, params })))
    ws.on('message', (raw) => {
      let msg: { id?: string; result?: unknown; error?: { message?: string } }
      try { msg = JSON.parse(String(raw)) } catch { return }
      if (msg.id !== 'hbn1') return
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

/** Tap an in-page element on the currently ACTIVE page via the automation pipeline. */
async function tapActivePageElement(selector: string): Promise<void> {
  const el = await wsCall<{ elementId?: string }>('Page.getElement', { selector })
  await wsCall('Element.tap', { elementId: el.elementId })
}

async function currentPagePath(): Promise<string> {
  const cur = await wsCall<{ path?: string }>('App.getCurrentPage').catch(() => null)
  return cur?.path ?? ''
}

async function pageStackLength(): Promise<number> {
  const stack = await wsCall<{ pageStack?: Array<{ path: string }> }>('App.getPageStack').catch(() => ({ pageStack: [] }))
  return stack.pageStack?.length ?? 0
}

/**
 * Close any open project, point the fixture's compile config at `startPage`,
 * then reopen so the fresh session launches directly on that page. Compile
 * config is scoped to THIS spec's private `--user-data-dir`, so it never
 * leaks into the shared worker-scoped Electron instance other specs use.
 */
async function openFixtureAt(startPage: string): Promise<void> {
  await closeProject(mainWindow).catch(() => {})
  await addProject(mainWindow, FIXTURE_DIR)
  await ipcInvoke(mainWindow, ProjectChannel.SaveCompileConfig, FIXTURE_DIR, {
    startPage,
    scene: DEFAULT_SCENE,
    queryParams: [],
  })
  await openProjectInUI(mainWindow, FIXTURE_DIR, { waitMs: 20000 })
  await waitForSimulatorWebview(electronApp)
  await pollUntil(
    () => evalInSimulator<boolean>(electronApp, `(() => !!document.querySelector('.device-shell-root'))()`).catch(() => false),
    (ok) => ok === true,
    25000,
    300,
  )
  await pollUntil(
    () => currentPagePath(),
    (p) => p.includes(startPage),
    20000,
    500,
  )
}

test.describe('native-host nav-bar home button (redirectTo/reLaunch branches)', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(120_000)

  test.beforeAll(async () => {
    const appPath = path.resolve(__dirname, 'electron-entry.js')
    const userDataDir = path.resolve(
      process.env.DIMINA_DEVTOOLS_DATA_DIR
        ?? path.resolve(__dirname, '..', 'node_modules', '.cache', 'devtools-e2e'),
      'userdata',
      `nh-home-button-notab-${process.pid}`,
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

  test('stack-bottom non-home page shows the home button alone; tapping it redirectTo\'s in place', async () => {
    await openFixtureAt(INNER_PAGE)

    const before = await readNavBarSnapshot()
    expect(before.hasHome, 'a non-home page at stack bottom should show the home button').toBe(true)
    expect(before.hasBack, 'stack-bottom page has no prior page to go back to').toBe(false)
    expect(before.hasTabBar, 'this fixture declares no tabBar').toBe(false)
    expect(await pageStackLength(), 'launching directly on a page yields a one-deep stack').toBe(1)

    const clicked = await clickHomeButton()
    expect(clicked, 'the home button must be clickable').toBe(true)

    const moved = await pollUntil(
      () => currentPagePath(),
      (p) => p.includes(HOME_PAGE),
      15000,
      400,
    )
    expect(moved, 'a non-tab home page reached from stack bottom should redirectTo home').toContain(HOME_PAGE)
    expect(
      await pageStackLength(),
      'redirectTo replaces the current page in place, so the stack stays one-deep',
    ).toBe(1)

    const after = await readNavBarSnapshot()
    expect(after.hasHome, 'the home button must disappear once on the home page').toBe(false)
    expect(after.hasBack, 'redirectTo leaves no page to go back to').toBe(false)
  })

  test('a deeper page opted into homeButton:true shows BOTH the back arrow and the home button; tapping home reLaunches', async () => {
    await openFixtureAt(INNER_PAGE)
    expect(await pageStackLength(), 'fresh launch on inner should start one-deep').toBe(1)

    await tapActivePageElement('.go-forced-btn')
    const onForced = await pollUntil(
      () => currentPagePath(),
      (p) => p.includes(FORCED_PAGE),
      15000,
      400,
    )
    expect(onForced, 'tapping the in-page button should navigateTo the forced page').toContain(FORCED_PAGE)
    expect(await pageStackLength(), 'navigateTo pushes a second page onto the stack').toBe(2)

    const midStack = await readNavBarSnapshot()
    expect(midStack.hasBack, 'a page reached via navigateTo has a prior page to go back to').toBe(true)
    expect(
      midStack.hasHome,
      'homeButton:true forces the home button to coexist with the back arrow',
    ).toBe(true)

    const clicked = await clickHomeButton()
    expect(clicked, 'the home button must be clickable alongside the back arrow').toBe(true)

    const backHome = await pollUntil(
      () => currentPagePath(),
      (p) => p.includes(HOME_PAGE),
      15000,
      400,
    )
    expect(backHome, 'a homeButton:true page not at stack bottom should reLaunch to home').toContain(HOME_PAGE)
    expect(
      await pageStackLength(),
      'reLaunch discards the whole stack, leaving only the home page',
    ).toBe(1)

    const after = await readNavBarSnapshot()
    expect(after.hasHome, 'the home button must disappear once on the home page').toBe(false)
    expect(after.hasBack, 'reLaunch leaves no page to go back to').toBe(false)
  })

  test('the app home page itself never shows the home button', async () => {
    await openFixtureAt(HOME_PAGE)

    const snap = await readNavBarSnapshot()
    expect(snap.hasHome, 'the home page must not offer a button back to itself').toBe(false)
    expect(snap.hasBack, 'the home page at stack bottom has no prior page').toBe(false)
  })
})
