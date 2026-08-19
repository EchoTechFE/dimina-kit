/**
 * E2E: `switchTab` crossing a tab substack that holds a landscape page pushed by `navigateTo` — the two cells `simulator-orientation.spec.ts` does not cover (that file only exercises `navigateTo` / `navigateBack` crossings and plain tab-to-tab switching while both tabs stay on the same orientation).
 *
 * `reduceSwitchTab` (page-stack-controller.ts) has two branches: restore a previously-visited tab from its cached substack, or open a fresh page when the target tab has never been visited.
 * The two tests below exercise one branch each and MUST run in this file order (`test.describe.configure({ mode: 'serial' })`, one shared app across both): the substack a `navigateTo` lands on stays cached on its tab across `switchTab`s — nothing in this UI ever discards it — so whichever test pushes a page onto tab2 has to run AFTER the one that needs tab2 to still be a fresh, never-visited tab.
 *
 *  - "a tab landed via switchTab uses its own config" (runs first) drives the
 * FRESH-OPEN branch: the landscape page is pushed onto tab1 (the tab already active), then switchTab targets tab2, which has no cache yet and must be opened from scratch — its own `auto` config on a portrait device, not anything inherited from tab1's now-hidden landscape page.
 * It resets both tabs back to a clean stack before returning, so it never contaminates the tab the next test needs untouched.
 *  - "switchTab restores a tab's own orientation" (runs second) drives the
 * CACHED-restore branch: tab2 is switched to first (a clean single-entry substack, established by the previous test), a landscape page is pushed onto tab2's substack, then switchTab returns to tab1 — which must read back its own untouched cache, not the landscape page buried in tab2's.
 *
 * The devtools tabBar is unmounted while a pushed (non-tab) page is on top — `simulator-orientation.spec.ts` already pins `tabBar === null` for that state — so a real click can never issue `switchTab` while the landscape page is on screen. `App.callWxMethod` over the automation WebSocket calls the SAME `wx.switchTab` a mini-app would call directly from that page (real apps commonly wire a "return to tab" button this way), which is the mechanism used below instead of a tabBar click for that specific step.
 */
import { test, expect, _electron, type ElectronApplication, type Page as PwPage } from '@playwright/test'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { WebSocket } from 'ws'
import {
  orientedDeviceMetrics,
  pageWindowSize,
  type Orientation,
} from '@dimina-kit/electron-runtime/shared/page-orientation'
import {
  ipcInvoke,
  openProjectInUI,
  pollUntil,
  waitForSimulatorWebview,
  waitSimulatorReady,
  closeProject,
} from './helpers'
import { AutomationChannel } from '../src/shared/ipc-channels'
import { DEVICES } from '../src/renderer/shared/constants'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = path.resolve(__dirname, 'fixtures', 'landscape-tabbar-app')

const DEVICE = DEVICES[1]!

let electronApp: ElectronApplication
let mainWindow: PwPage
let autoPort = 0

// One-shot JSON-RPC call to the miniprogram-automator WebSocket server — mirrors the helper in native-host-wx-method.spec.ts / native-host-current-page.spec.ts.
function wsCall<T = Record<string, unknown>>(
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 12000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${autoPort}`)
    const timer = setTimeout(() => { ws.close(); reject(new Error(`wsCall ${method} timed out`)) }, timeoutMs)
    ws.on('open', () => ws.send(JSON.stringify({ id: 'orient-tabbar', method, params })))
    ws.on('message', (raw) => {
      let msg: { id?: string; result?: unknown; error?: { message?: string } }
      try { msg = JSON.parse(String(raw)) } catch { return }
      if (msg.id !== 'orient-tabbar') return
      clearTimeout(timer)
      ws.close()
      if (msg.error) reject(new Error(msg.error.message || 'rpc error'))
      else resolve(msg.result as T)
    })
    ws.on('error', (err) => { clearTimeout(timer); reject(err) })
  })
}

async function callWx(method: string, args: unknown[] = []): Promise<void> {
  await wsCall('App.callWxMethod', { method, args })
}

// ── Shell introspection (trimmed to what these two tests read) ──────────────

interface ShellSnapshot {
  screen: { width: number; height: number } | null
  tabBar: { width: number; height: number } | null
  navTitle: string
  navCustom: boolean
  selectedTab: string | null
}

const SHELL_SNAPSHOT_EXPR = `(() => {
  const rect = (el) => el
    ? (({ width, height }) => ({ width: Math.round(width), height: Math.round(height) }))(el.getBoundingClientRect())
    : null
  const shellEl = document.querySelector('.device-shell')
  const navEl = document.querySelector('.nav-bar')
  const tabBarEl = document.querySelector('.dmb-tab-bar')
  const selected = document.querySelector('.dmb-tab-bar__item.is-selected')
  return JSON.stringify({
    screen: shellEl ? { width: shellEl.clientWidth, height: shellEl.clientHeight } : null,
    tabBar: rect(tabBarEl),
    navTitle: (document.querySelector('.nav-bar__title-text') || {}).textContent || '',
    navCustom: !!navEl && navEl.classList.contains('nav-bar--custom'),
    selectedTab: selected ? (selected.querySelector('.dmb-tab-bar__text') || {}).textContent || '' : null,
  })
})()`

async function evalInSim<T>(expr: string): Promise<T> {
  return electronApp.evaluate(async ({ webContents }, expression) => {
    const all = webContents.getAllWebContents()
    const sim = all.find((wc) => wc.getURL().includes('simulator.html')) ?? all.find((wc) => wc.getType() === 'webview')
    if (!sim || sim.isLoading()) throw new Error('simulator webview not ready')
    return sim.executeJavaScript(expression)
  }, expr) as Promise<T>
}

async function readShell(): Promise<ShellSnapshot> {
  return JSON.parse(await evalInSim<string>(SHELL_SNAPSHOT_EXPR)) as ShellSnapshot
}

async function waitForShell(predicate: (s: ShellSnapshot) => boolean, timeout = 15000): Promise<ShellSnapshot> {
  return pollUntil(readShell, predicate, timeout, 250)
}

const isLandscape = (s: ShellSnapshot): boolean => !!s.screen && s.screen.width > s.screen.height

interface Geometry {
  systemInfo: { windowWidth: number; windowHeight: number; deviceOrientation: Orientation }
}

async function readGeometry(marker: string): Promise<Geometry | null> {
  const raw = await electronApp.evaluate(async ({ webContents }, payload) => {
    for (const wc of webContents.getAllWebContents()) {
      if (!wc.getURL().includes('__frame__')) continue
      if (wc.isLoading()) continue
      try {
        const out = await wc.executeJavaScript(
          `(() => document.querySelector(${JSON.stringify(`.${payload.marker}`)}) ? (document.querySelector('.probe-geometry').textContent || '') : null)()`,
        )
        if (out) return out as string
      } catch { /* a guest torn down mid-iteration is not the one we want */ }
    }
    return null
  }, { marker })
  if (!raw) return null
  try { return JSON.parse(raw) as Geometry } catch { return null }
}

async function waitForGeometry(marker: string, predicate: (g: Geometry) => boolean, timeout = 15000): Promise<Geometry> {
  const g = await pollUntil(() => readGeometry(marker), (v) => !!v && predicate(v), timeout, 250)
  expect(g, `page .${marker} should publish its geometry probe`).toBeTruthy()
  return g!
}

/** Fire a real click on an element inside a render guest (drives `bindtap`). */
async function tapInGuest(marker: string, selector: string): Promise<void> {
  const ok = await electronApp.evaluate(async ({ webContents }, payload) => {
    for (const wc of webContents.getAllWebContents()) {
      if (!wc.getURL().includes('__frame__') || wc.isLoading()) continue
      try {
        const out = await wc.executeJavaScript(
          `(() => { const el = document.querySelector(${JSON.stringify(`.${payload.marker}`)}) ? document.querySelector(${JSON.stringify(payload.selector)}) : null; if (!el) return false; el.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true })()`,
        )
        if (out) return true
      } catch { /* a guest torn down mid-iteration is not the one we want */ }
    }
    return false
  }, { marker, selector })
  expect(ok, `tap ${selector} inside .${marker}`).toBe(true)
}

/** Click a tabBar item by its label — the same button a user presses. */
async function tapTab(text: string): Promise<void> {
  const ok = await evalInSim<boolean>(`(() => {
    const item = [...document.querySelectorAll('.dmb-tab-bar__item')]
      .find((b) => ((b.querySelector('.dmb-tab-bar__text') || {}).textContent || '').trim() === ${JSON.stringify(text)})
    if (!item) return false
    item.click()
    return true
  })()`)
  expect(ok, `tabBar item "${text}" should exist and be clickable`).toBe(true)
}

/** Unwind back to tab1 so a test never inherits state left over from another. */
async function resetToTab1(): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const s = await readShell()
    if (s.tabBar && s.selectedTab === 'Tab1' && !s.navCustom) return
    const wentBack = await evalInSim<boolean>(`(() => {
      const b = document.querySelector('.nav-bar__back')
      if (!b) return false
      b.click()
      return true
    })()`)
    if (!wentBack) await tapTab('Tab1')
    await new Promise((r) => setTimeout(r, 500))
  }
  await waitForShell((v) => !!v.tabBar && v.selectedTab === 'Tab1' && !v.navCustom)
}

test.describe('simulator orientation: switchTab crossing a landscape tab substack', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(180_000)

  test.beforeAll(async () => {
    const appPath = path.resolve(__dirname, 'electron-entry.js')
    const userDataDir = path.resolve(
      process.env.DIMINA_DEVTOOLS_DATA_DIR
        ?? path.resolve(__dirname, '..', 'node_modules', '.cache', 'devtools-e2e'),
      'userdata',
      `orientation-tabbar-${process.pid}`,
    )
    fs.mkdirSync(userDataDir, { recursive: true })

    electronApp = await _electron.launch({
      args: [appPath, 'auto', '--auto-port', '0', `--user-data-dir=${userDataDir}`],
      env: { ...process.env, NODE_ENV: 'test', DIMINA_NATIVE_HOST: '1', DIMINA_E2E_USER_DATA_DIR: userDataDir },
    })
    mainWindow = await electronApp.firstWindow()
    await mainWindow.waitForLoadState('domcontentloaded')

    autoPort = await pollUntil(
      () => ipcInvoke<number | null>(mainWindow, AutomationChannel.GetPort),
      (val) => typeof val === 'number' && val > 0,
      10000,
      100,
    ) as number

    await openProjectInUI(mainWindow, FIXTURE_DIR, { waitMs: 40000 })
    await waitForSimulatorWebview(electronApp)
    await waitSimulatorReady(electronApp)
    await waitForShell((s) => !!s.tabBar, 40000)
  })

  test.afterAll(async () => {
    await closeProject(mainWindow).catch(() => {})
    await electronApp?.close().catch(() => {})
  })

  test('a tab landed via switchTab uses its own config, unaffected by a landscape page hidden in another tab\'s substack', async () => {
    await resetToTab1()

    // Push the landscape page onto TAB1's own substack via the existing button.
    await tapInGuest('page-tab1', '.goto-detail-btn')
    const pushed = await waitForShell((v) => v.navTitle === 'Landscape Detail', 20000)
    expect(isLandscape(pushed)).toBe(true)
    expect(pushed.tabBar).toBeNull()

    // switchTab to tab2, which has no cached substack yet — must be opened fresh from its own config, not inherit anything from tab1's hidden page.
    await callWx('switchTab', [{ url: '/pages/tab2/tab2' }])
    const landed = await waitForShell((v) => !!v.tabBar && v.selectedTab === 'Tab2', 20000)
    expect(isLandscape(landed), 'tab2 must show its own portrait orientation, not the landscape page hidden on tab1').toBe(false)
    expect(landed.navCustom, 'tab2 keeps its own navigationStyle: custom').toBe(true)

    const g = await waitForGeometry('page-tab2', (v) => v.systemInfo.deviceOrientation === 'portrait', 20000)
    const portraitMetrics = orientedDeviceMetrics(
      { screenWidth: DEVICE.width, screenHeight: DEVICE.height, statusBarHeight: DEVICE.statusBarHeight },
      'portrait',
    )
    const expected = pageWindowSize(portraitMetrics, { navigationStyle: 'custom', isTab: true, bottomInset: DEVICE.safeAreaInsets.bottom })
    expect(g.systemInfo.windowHeight).toBe(expected.windowHeight)

    // Leave both tabs on a clean single-entry stack: tab1 still has the landscape page cached on top of its substack at this point, and the next test needs a genuinely untouched tab1 to restore.
    await resetToTab1()
  })

  test('switchTab restores a tab\'s own orientation after crossing a landscape page pushed onto a DIFFERENT tab', async () => {
    await resetToTab1()

    // tab2 already has a clean, single-entry cached substack from the previous test — switching to it here does not open it fresh.
    await tapTab('Tab2')
    await waitForShell((v) => !!v.tabBar && v.selectedTab === 'Tab2' && !isLandscape(v))

    // Push the landscape page onto TAB2's substack — tab1's cache stays untouched.
    // No button reaches this from tab2, so this goes through the same wx.navigateTo a mini-app itself would call.
    await callWx('navigateTo', [{ url: '/pages/detail/detail' }])
    const pushed = await waitForShell((v) => v.navTitle === 'Landscape Detail', 20000)
    expect(isLandscape(pushed), 'the pushed page must turn the screen landscape').toBe(true)
    expect(pushed.tabBar, 'a pushed non-tab page hides the tabBar').toBeNull()

    // switchTab back to tab1 — its substack was never touched by the push above, so restoring it must read tab1's own (auto, portrait-device) config.
    await callWx('switchTab', [{ url: '/pages/tab1/tab1' }])
    const restored = await waitForShell((v) => !!v.tabBar && v.selectedTab === 'Tab1', 20000)
    expect(isLandscape(restored), 'tab1 must show its own portrait orientation, not the landscape page left behind on tab2').toBe(false)
    expect(restored.navTitle).toBe('Tab One')

    const g = await waitForGeometry('page-tab1', (v) => v.systemInfo.deviceOrientation === 'portrait', 20000)
    expect(g.systemInfo.windowWidth).toBe(DEVICE.width)
  })
})
