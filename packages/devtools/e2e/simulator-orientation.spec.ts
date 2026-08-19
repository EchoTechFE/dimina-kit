/**
 * E2E: screen orientation inside the REAL devtools application UI — the phone shell drawn by DeviceShell in the simulator WebContentsView, driven by the renderer toolbar's own rotate control and by `pageOrientation` config.
 *
 * The runtime package's own orientation specs cover the bare runtime harness (`packages/dimina-electron-runtime/e2e/native-host-orientation-*.spec.ts`) against fixtures with neither a tabBar nor `navigationStyle`.
 * What this file guards is the part only the devtools shell can answer: where the navigation bar and the tabBar end up once the screen turns, whether either clips or overlaps the page, and whether the simulated device's own orientation survives the mini-app forcing a different one and then exiting.
 *
 * Geometry expectations are derived from the same pure functions the product derives them from (`shared/page-orientation`), so a deliberate metric change moves test and product together while an accidental layout regression still fails.
 */
import { test, expect, _electron, type ElectronApplication, type Page as PwPage } from '@playwright/test'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  NAV_BAR_HEIGHT,
  orientedDeviceMetrics,
  pageWindowSize,
  tabBarReservedHeight,
  type Orientation,
} from '@dimina-kit/electron-runtime/shared/page-orientation'
import {
  closeProject,
  evalInSimulator,
  ipcInvoke,
  openProjectInUI,
  pollUntil,
  waitForSimulatorWebview,
  waitSimulatorReady,
} from './helpers'
import { SimulatorChannel } from '../src/shared/ipc-channels'
import { DEVICES } from '../src/renderer/shared/constants'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = path.resolve(__dirname, 'fixtures', 'landscape-tabbar-app')

/**
 * Screenshots are evidence for a human reviewer — every orientation-relevant state gets one, under a stable path so a run can be inspected afterwards.
 */
const SHOT_DIR = path.resolve(__dirname, '..', 'node_modules', '.cache', 'landscape-shots')

/** The device ProjectRuntime opens with (`use-project-runtime-controller.ts` default). */
const DEVICE = DEVICES[1]!
const BOTTOM_INSET = DEVICE.safeAreaInsets.bottom

let electronApp: ElectronApplication
let mainWindow: PwPage

// ── Expected geometry, derived from the product's own pure functions ─────────

function metricsAt(orientation: Orientation) {
  return orientedDeviceMetrics(
    { screenWidth: DEVICE.width, screenHeight: DEVICE.height, statusBarHeight: DEVICE.statusBarHeight },
    orientation,
  )
}

function expectedWindow(
  orientation: Orientation,
  chrome: { navigationStyle: 'default' | 'custom'; isTab: boolean },
) {
  return pageWindowSize(metricsAt(orientation), { ...chrome, bottomInset: BOTTOM_INSET })
}

// ── Shell introspection ──────────────────────────────────────────────────────

interface Rect { x: number; y: number; width: number; height: number }

interface ShellSnapshot {
  /** Inner size of `.device-shell` (bezel border excluded) — the device's logical screen. */
  screen: { width: number; height: number } | null
  /** The screen's own content box in viewport coordinates — the frame every chrome rect is checked against. */
  screenBox: Rect | null
  statusBar: Rect | null
  nav: Rect | null
  navCustom: boolean
  navTitle: string
  viewport: Rect | null
  tabBar: Rect | null
  tabTexts: string[]
  selectedTab: string | null
  /** The one render-host webview currently displayed (others are `display:none`). */
  visibleWebview: Rect | null
  webviewCount: number
}

// Rects are rounded to whole pixels: the simulator renders under a zoom factor, which leaves sub-pixel residue (a 44pt bar measures 43.998) that says nothing about the layout being asserted here.
const SHELL_SNAPSHOT_EXPR = `(() => {
  const rect = (el) => el
    ? (({ x, y, width, height }) => ({
        x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height),
      }))(el.getBoundingClientRect())
    : null
  const shellEl = document.querySelector('.device-shell')
  const navEl = document.querySelector('.nav-bar')
  const tabBarEl = document.querySelector('.dmb-tab-bar')
  const selected = document.querySelector('.dmb-tab-bar__item.is-selected')
  const visible = [...document.querySelectorAll('.device-shell__webview')]
    .find((w) => w.style.display !== 'none')
  const shellRect = rect(shellEl)
  return JSON.stringify({
    screen: shellEl ? { width: shellEl.clientWidth, height: shellEl.clientHeight } : null,
    // The bezel draws a 1px border, so the screen's content box is inset from the element's border box by clientTop/clientLeft.
    screenBox: shellEl && shellRect
      ? {
          x: Math.round(shellRect.x + shellEl.clientLeft),
          y: Math.round(shellRect.y + shellEl.clientTop),
          width: shellEl.clientWidth,
          height: shellEl.clientHeight,
        }
      : null,
    statusBar: rect(document.querySelector('.device-statusbar')),
    nav: rect(navEl),
    navCustom: !!navEl && navEl.classList.contains('nav-bar--custom'),
    navTitle: (document.querySelector('.nav-bar__title-text') || {}).textContent || '',
    viewport: rect(document.querySelector('.device-shell__viewport')),
    tabBar: rect(tabBarEl),
    tabTexts: [...document.querySelectorAll('.dmb-tab-bar__text')].map((e) => e.textContent || ''),
    selectedTab: selected ? (selected.querySelector('.dmb-tab-bar__text') || {}).textContent || '' : null,
    visibleWebview: rect(visible),
    webviewCount: document.querySelectorAll('.device-shell__webview').length,
  })
})()`

async function readShell(): Promise<ShellSnapshot> {
  return JSON.parse(await evalInSimulator<string>(electronApp, SHELL_SNAPSHOT_EXPR)) as ShellSnapshot
}

async function waitForShell(
  predicate: (s: ShellSnapshot) => boolean,
  timeout = 15000,
): Promise<ShellSnapshot> {
  return pollUntil(readShell, predicate, timeout, 250)
}

const isLandscape = (s: ShellSnapshot): boolean => !!s.screen && s.screen.width > s.screen.height

// ── Page (render-guest) introspection ────────────────────────────────────────

interface Geometry {
  systemInfo: {
    screenWidth: number
    screenHeight: number
    windowWidth: number
    windowHeight: number
    statusBarHeight: number
    deviceOrientation: Orientation
    safeArea: { left: number; top: number; right: number; bottom: number; width: number; height: number }
  }
  windowInfo?: Geometry['systemInfo']
}

/**
 * Read one page's DOM by the marker class its wxml carries.
 * Tab substacks keep hidden pages mounted, so the marker (unique per page) is what identifies the guest, not "the only frame that exists".
 */
async function readGuest<T>(marker: string, expression: string): Promise<T | null> {
  const raw = await electronApp.evaluate(async ({ webContents }, payload) => {
    for (const wc of webContents.getAllWebContents()) {
      if (!wc.getURL().includes('__frame__')) continue
      if (wc.isLoading()) continue
      try {
        const out = await wc.executeJavaScript(
          `(() => document.querySelector(${JSON.stringify(`.${payload.marker}`)}) ? JSON.stringify(${payload.expression}) : null)()`,
        )
        if (out !== null && out !== undefined) return out as string
      } catch { /* a guest torn down mid-iteration is not the one we want */ }
    }
    return null
  }, { marker, expression })
  return raw === null ? null : (JSON.parse(raw) as T)
}

async function readGeometry(marker: string): Promise<Geometry | null> {
  const text = await readGuest<string>(marker, `(document.querySelector('.probe-geometry') || {}).textContent || ''`)
  if (!text) return null
  try { return JSON.parse(text) as Geometry } catch { return null }
}

async function waitForGeometry(
  marker: string,
  predicate: (g: Geometry) => boolean,
  timeout = 15000,
): Promise<Geometry> {
  const g = await pollUntil(() => readGeometry(marker), (v) => !!v && predicate(v), timeout, 250)
  expect(g, `page .${marker} should publish its geometry probe`).toBeTruthy()
  return g!
}

/** Fire a real click on an element inside a render guest (drives `bindtap`). */
async function tapInGuest(marker: string, selector: string): Promise<void> {
  const ok = await readGuest<boolean>(
    marker,
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true })()`,
  )
  expect(ok, `tap ${selector} inside .${marker}`).toBe(true)
}

/**
 * Unwind the page stack back to tab1 so a test never inherits a pushed page from the one before it — including from a test that stopped mid-flow.
 */
async function resetToTab1(): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const s = await readShell()
    if (s.tabBar && s.selectedTab === 'Tab1' && !s.navCustom) return
    const wentBack = await evalInSimulator<boolean>(electronApp, `(() => {
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

/** Click a tabBar item by its label — the same button a user presses. */
async function tapTab(text: string): Promise<void> {
  const ok = await evalInSimulator<boolean>(electronApp, `(() => {
    const item = [...document.querySelectorAll('.dmb-tab-bar__item')]
      .find((b) => ((b.querySelector('.dmb-tab-bar__text') || {}).textContent || '').trim() === ${JSON.stringify(text)})
    if (!item) return false
    item.click()
    return true
  })()`)
  expect(ok, `tabBar item "${text}" should exist and be clickable`).toBe(true)
}

// ── Toolbar rotate control (real renderer UI) ────────────────────────────────

const rotateButton = () => mainWindow.locator('[data-testid="sim-rotate-device"]')

async function clickRotate(): Promise<void> {
  const btn = rotateButton()
  await expect(btn, 'the rotate control must be enabled for an `auto` page').toBeEnabled({ timeout: 10000 })
  await btn.click()
}

// ── Screenshots ──────────────────────────────────────────────────────────────

async function shot(name: string): Promise<void> {
  const b64 = await electronApp.evaluate(async ({ webContents }) => {
    const all = webContents.getAllWebContents()
    const sim = all.find((wc) => wc.getURL().includes('simulator.html'))
    if (!sim) return null
    // `capturePage` returns whatever is composited right now, which can still be the frame from before the last DOM change — a screenshot of a page the assertions have already moved past.
    // Await two animation frames in the shell AND in every render guest first, so the capture is of a committed frame rather than a race with the compositor.
    const painted = all.filter((wc) => wc === sim || wc.getURL().includes('__frame__'))
    await Promise.all(painted.map((wc) => (wc.isLoading()
      ? Promise.resolve(null)
      : wc.executeJavaScript(
        'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))',
      ).catch(() => null))))
    const img = await sim.capturePage()
    return img.toPNG().toString('base64')
  })
  expect(b64, `screenshot ${name} should capture the simulator view`).toBeTruthy()
  fs.writeFileSync(path.join(SHOT_DIR, `${name}.png`), Buffer.from(b64 as string, 'base64'))
}

// ── Layout invariants shared by every orientation ────────────────────────────

function expectChromeInsideScreen(s: ShellSnapshot): void {
  expect(s.screenBox, 'the phone shell must be mounted').toBeTruthy()
  const screen = s.screenBox!
  for (const [label, r] of Object.entries({ nav: s.nav, viewport: s.viewport, tabBar: s.tabBar })) {
    if (!r) continue
    expect(r.x, `${label} must not start left of the screen`).toBeGreaterThanOrEqual(screen.x - 1)
    expect(r.x + r.width, `${label} must not overflow the right edge`).toBeLessThanOrEqual(screen.x + screen.width + 1)
    expect(r.y, `${label} must not start above the screen`).toBeGreaterThanOrEqual(screen.y - 1)
    expect(r.y + r.height, `${label} must not overflow the bottom edge`).toBeLessThanOrEqual(screen.y + screen.height + 1)
    expect(r.height, `${label} must have a non-zero height (not collapsed/clipped away)`).toBeGreaterThan(0)
  }
}

function expectNoTabBarOverlap(s: ShellSnapshot): void {
  expect(s.tabBar, 'a tab page must render the tabBar').toBeTruthy()
  expect(s.viewport, 'the page viewport must be mounted').toBeTruthy()
  expect(
    s.viewport!.y + s.viewport!.height,
    'the tabBar must sit below the page viewport, not on top of it',
  ).toBeLessThanOrEqual(s.tabBar!.y + 1)
  expect(
    Math.abs((s.tabBar!.y + s.tabBar!.height) - (s.screenBox!.y + s.screenBox!.height)),
    'the tabBar must end flush with the bottom of the screen',
  ).toBeLessThanOrEqual(1)
}

// ── Suite ────────────────────────────────────────────────────────────────────

test.describe('simulator orientation: navigation bar + tabBar', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(180_000)

  test.beforeAll(async () => {
    fs.mkdirSync(SHOT_DIR, { recursive: true })
    const appPath = path.resolve(__dirname, 'electron-entry.js')
    const userDataDir = path.resolve(
      process.env.DIMINA_DEVTOOLS_DATA_DIR
        ?? path.resolve(__dirname, '..', 'node_modules', '.cache', 'devtools-e2e'),
      'userdata',
      `orientation-${process.pid}`,
    )
    fs.mkdirSync(userDataDir, { recursive: true })

    electronApp = await _electron.launch({
      args: [appPath, `--user-data-dir=${userDataDir}`],
      env: { ...process.env, NODE_ENV: 'test', DIMINA_NATIVE_HOST: '1', DIMINA_E2E_USER_DATA_DIR: userDataDir },
    })
    mainWindow = await electronApp.firstWindow()
    await mainWindow.waitForLoadState('domcontentloaded')

    await openProjectInUI(mainWindow, FIXTURE_DIR, { waitMs: 40000 })
    await waitForSimulatorWebview(electronApp)
    await waitSimulatorReady(electronApp)
    await waitForShell((s) => !!s.tabBar && s.webviewCount >= 1, 40000)
  })

  test.afterAll(async () => {
    await closeProject(mainWindow).catch(() => {})
    await electronApp?.close().catch(() => {})
  })

  test('portrait baseline: nav bar, tabBar and page area tile the device screen', async () => {
    const s = await waitForShell((v) => !isLandscape(v) && !!v.tabBar)
    const portrait = metricsAt('portrait')

    expect(s.screen).toEqual({ width: portrait.screenWidth, height: portrait.screenHeight })
    expect(s.statusBar?.height, 'portrait keeps the status bar').toBe(DEVICE.statusBarHeight)
    expect(s.nav?.height, 'default nav bar spans status bar + 44pt row').toBe(DEVICE.statusBarHeight + NAV_BAR_HEIGHT)
    expect(s.navTitle).toBe('Tab One')
    expect(s.tabBar?.height, 'tabBar reserves row + bottom inset + border').toBe(tabBarReservedHeight(BOTTOM_INSET))
    expect(s.tabTexts).toEqual(['Tab1', 'Tab2'])
    expect(s.selectedTab).toBe('Tab1')

    const expected = expectedWindow('portrait', { navigationStyle: 'default', isTab: true })
    expect(s.viewport?.height, 'page viewport is the screen minus nav bar and tabBar').toBe(expected.windowHeight)
    expectChromeInsideScreen(s)
    expectNoTabBarOverlap(s)

    const g = await waitForGeometry('page-tab1', (v) => v.systemInfo.deviceOrientation === 'portrait')
    expect(g.systemInfo.windowWidth).toBe(expected.windowWidth)
    expect(g.systemInfo.windowHeight).toBe(expected.windowHeight)
    expect(g.systemInfo.screenWidth).toBe(portrait.screenWidth)
    expect(g.systemInfo.screenHeight).toBe(portrait.screenHeight)
    expect(g.windowInfo?.windowHeight, 'getWindowInfo agrees with getSystemInfoSync').toBe(expected.windowHeight)

    await shot('01-portrait-tab1-baseline')
  })

  test('toolbar rotate control turns the screen landscape without clipping nav bar or tabBar', async () => {
    await clickRotate()

    const s = await waitForShell(isLandscape)
    const landscape = metricsAt('landscape')

    expect(s.screen, 'landscape swaps the device width and height')
      .toEqual({ width: landscape.screenWidth, height: landscape.screenHeight })
    expect(s.statusBar, 'a phone in landscape draws no status bar').toBeNull()
    expect(s.nav?.height, 'the nav bar keeps its 44pt row with no status bar above it').toBe(NAV_BAR_HEIGHT)
    expect(s.nav?.width, 'the nav bar spans the full landscape width').toBe(landscape.screenWidth)
    expect(s.navTitle, 'the nav bar still shows the page title').toBe('Tab One')
    expect(s.tabBar?.height, 'the tabBar keeps its height across orientations').toBe(tabBarReservedHeight(BOTTOM_INSET))
    expect(s.tabBar?.width).toBe(landscape.screenWidth)
    expect(s.tabTexts).toEqual(['Tab1', 'Tab2'])

    const expected = expectedWindow('landscape', { navigationStyle: 'default', isTab: true })
    expect(s.viewport?.height).toBe(expected.windowHeight)
    expect(s.viewport?.width).toBe(expected.windowWidth)
    expectChromeInsideScreen(s)
    expectNoTabBarOverlap(s)

    const g = await waitForGeometry('page-tab1', (v) => v.systemInfo.deviceOrientation === 'landscape')
    expect(g.systemInfo.windowWidth).toBe(expected.windowWidth)
    expect(g.systemInfo.windowHeight).toBe(expected.windowHeight)
    expect(g.systemInfo.statusBarHeight, 'landscape reports no status bar height').toBe(0)
    // Landscape safe area is recomputed, not rotated: the notch moves to both side edges and the top frees up entirely (`orientedSafeAreaInsets`).
    expect(g.systemInfo.safeArea.top, 'no status bar means no top inset').toBe(0)
    expect(g.systemInfo.safeArea.left, 'the notch eats into the left edge in landscape').toBe(DEVICE.statusBarHeight)
    expect(g.systemInfo.safeArea.right).toBe(landscape.screenWidth - DEVICE.statusBarHeight)

    // The page's own viewport must have the shape of the reported window and must not overflow it.
    // Simulator zoom scales the guest viewport uniformly (its px count is the logical size divided by the zoom factor), so the zoom-invariant statement is the aspect ratio, not the pixel count.
    const view = await readGuest<{ w: number; h: number; scrollW: number }>(
      'page-tab1',
      `({ w: window.innerWidth, h: window.innerHeight, scrollW: document.documentElement.scrollWidth })`,
    )
    expect(view!.w, 'the page area itself is landscape-shaped').toBeGreaterThan(view!.h)
    expect(view!.w / view!.h).toBeCloseTo(expected.windowWidth / expected.windowHeight, 1)
    expect(view!.scrollW, 'the page must not overflow its viewport horizontally').toBeLessThanOrEqual(view!.w + 1)

    await shot('02-landscape-tab1-navbar-tabbar')
  })

  test('landscape tab2 with navigationStyle custom reaches the very top of the screen', async () => {
    await tapTab('Tab2')
    const s = await waitForShell((v) => isLandscape(v) && v.selectedTab === 'Tab2' && v.navCustom)

    expect(s.navCustom, 'a custom nav bar is taken out of the layout flow').toBe(true)
    expect(s.statusBar, 'custom nav in landscape reserves no status bar either').toBeNull()
    expect(Math.abs(s.viewport!.y - s.screenBox!.y), 'the page starts at the top edge of the screen')
      .toBeLessThanOrEqual(1)

    const expected = expectedWindow('landscape', { navigationStyle: 'custom', isTab: true })
    expect(s.viewport?.height, 'a custom-nav tab page only gives up the tabBar').toBe(expected.windowHeight)
    expectChromeInsideScreen(s)
    expectNoTabBarOverlap(s)

    const g = await waitForGeometry('page-tab2', (v) => v.systemInfo.windowWidth === expected.windowWidth)
    expect(g.systemInfo.windowHeight).toBe(expected.windowHeight)
    expect(g.systemInfo.statusBarHeight).toBe(0)

    // The page's own first row must be painted at y=0 of its viewport: nothing (status bar or nav bar) is allowed to push it down.
    const stripTop = await readGuest<number>('page-tab2', `document.querySelector('.tab2-top-strip').getBoundingClientRect().top`)
    expect(Math.abs(stripTop ?? NaN), 'the custom-nav page paints its first row at the screen top').toBeLessThanOrEqual(1)

    await shot('03-landscape-tab2-custom-nav')
  })

  test('switching tabs in landscape keeps both pages laid out and painted', async () => {
    await tapTab('Tab1')
    const back = await waitForShell((v) => isLandscape(v) && v.selectedTab === 'Tab1' && !v.navCustom)
    expect(back.navTitle, "switching back restores tab1's own nav bar").toBe('Tab One')
    expect(back.viewport?.height).toBe(expectedWindow('landscape', { navigationStyle: 'default', isTab: true }).windowHeight)
    expectNoTabBarOverlap(back)
    // A blank page after a tab switch is the failure this guards: the marker must still be laid out with a real box in the restored guest.
    const tab1Marker = await readGuest<{ text: string; width: number; height: number }>(
      'page-tab1',
      `(() => { const el = document.querySelector('.page-tab1'); const r = el.getBoundingClientRect(); return { text: el.textContent, width: r.width, height: r.height } })()`,
    )
    expect(tab1Marker?.text).toContain('TAB1')
    expect(tab1Marker!.width).toBeGreaterThan(0)
    expect(tab1Marker!.height).toBeGreaterThan(0)

    await tapTab('Tab2')
    const second = await waitForShell((v) => isLandscape(v) && v.selectedTab === 'Tab2' && v.navCustom)
    expect(Math.abs(second.viewport!.y - second.screenBox!.y)).toBeLessThanOrEqual(1)
    const tab2Marker = await readGuest<{ text: string; width: number; height: number }>(
      'page-tab2',
      `(() => { const el = document.querySelector('.page-tab2'); const r = el.getBoundingClientRect(); return { text: el.textContent, width: r.width, height: r.height } })()`,
    )
    expect(tab2Marker?.text).toContain('TAB2')
    expect(tab2Marker!.height).toBeGreaterThan(0)

    await tapTab('Tab1')
    const third = await waitForShell((v) => isLandscape(v) && v.selectedTab === 'Tab1' && !v.navCustom)
    expect(third.screen).toEqual(second.screen)
    expectChromeInsideScreen(third)
    await shot('04-landscape-tab1-after-tab-churn')

    // Hand the next test a portrait baseline again.
    await clickRotate()
    await waitForShell((v) => !isLandscape(v))
  })

  test('navigateTo a page-level landscape page reports landscape; navigateBack restores the tab page', async () => {
    await resetToTab1()
    const before = await waitForShell((v) => !isLandscape(v) && v.selectedTab === 'Tab1')
    expect(before.screen!.height).toBeGreaterThan(before.screen!.width)
    await shot('05-portrait-tab1-before-navigate')

    await tapInGuest('page-tab1', '.goto-detail-btn')

    const during = await waitForShell((v) => v.navTitle === 'Landscape Detail', 20000)
    expect(during.tabBar, 'a non-tab page hides the tabBar').toBeNull()

    const detailExpected = expectedWindow('landscape', { navigationStyle: 'default', isTab: false })
    const g = await waitForGeometry('page-detail', (v) => v.systemInfo.deviceOrientation === 'landscape', 20000)
    expect(g.systemInfo.windowWidth, 'the page-level landscape config wins over the portrait device')
      .toBe(detailExpected.windowWidth)
    expect(g.systemInfo.windowHeight).toBe(detailExpected.windowHeight)
    expect(g.systemInfo.statusBarHeight).toBe(0)
    await shot('06-landscape-detail-page-orientation')

    await expect(
      rotateButton(),
      'a fixed-orientation page disables the rotate control',
    ).toBeDisabled({ timeout: 10000 })

    await tapInGuest('page-detail', '.detail-back-btn')
    const after = await waitForShell((v) => v.navTitle === 'Tab One' && !!v.tabBar, 20000)
    expect(after.screen, 'going back restores the orientation the stack had before the push')
      .toEqual({ width: DEVICE.width, height: DEVICE.height })
    expect(after.viewport?.height, 'the restored tab page gets its portrait window area back')
      .toBe(expectedWindow('portrait', { navigationStyle: 'default', isTab: true }).windowHeight)
    expectNoTabBarOverlap(after)
    await shot('07-portrait-tab1-after-back')
  })

  /**
   * A page reads its geometry in `onShow`, so the host-env snapshot must already describe the page being shown by then.
   * Routing publishes the incoming page's resize before it dispatches the lifecycle events (see the runtime MiniAppFrame routing commit) — without that ordering the restored tab page would keep reading the popped landscape page's metrics forever, since its own size never changed and no `onResize` would ever correct it.
   */
  test('a page restored by navigateBack reads its own window metrics in onShow', async () => {
    await resetToTab1()
    await tapInGuest('page-tab1', '.goto-detail-btn')
    await waitForShell((v) => v.navTitle === 'Landscape Detail', 20000)
    await waitForGeometry('page-detail', (v) => v.systemInfo.deviceOrientation === 'landscape', 20000)

    await tapInGuest('page-detail', '.detail-back-btn')
    await waitForShell((v) => v.navTitle === 'Tab One' && !!v.tabBar, 20000)
    const restored = await waitForGeometry('page-tab1', (v) => v.systemInfo.deviceOrientation === 'portrait', 8000)
    expect(restored.systemInfo.windowWidth, 'the restored tab page must not report the popped page geometry')
      .toBe(DEVICE.width)
  })

  /**
   * Route linkage: entering a page pinned to an orientation different from the one on screen switches the screen — the drawn phone shell, not just the geometry the mini-app is told. `useOrientation` registers the top page during render, so the very first render that receives a routed-in page already measures it at its own orientation.
   */
  test('the phone shell follows a route-driven orientation change', async () => {
    await resetToTab1()
    await tapInGuest('page-tab1', '.goto-detail-btn')
    const during = await waitForShell((v) => v.navTitle === 'Landscape Detail', 20000)
    expect(isLandscape(during), 'the shell must draw the pushed page landscape').toBe(true)
    expect(during.statusBar, 'landscape drops the status bar on the pushed page too').toBeNull()
    expect(during.nav?.height).toBe(NAV_BAR_HEIGHT)
    expect(during.viewport?.height)
      .toBe(expectedWindow('landscape', { navigationStyle: 'default', isTab: false }).windowHeight)
  })

  /**
   * `safeArea` must describe the orientation actually on screen — the same `orientedSafeAreaInsets` answer the device-rotation path delivers.
   * The insets travel with the screen metrics in the resize host-env patch, so a page pinned to landscape never reads a top inset for a status bar that is not being drawn.
   */
  test('safeArea follows a route-driven orientation change', async () => {
    await resetToTab1()
    await tapInGuest('page-tab1', '.goto-detail-btn')
    await waitForShell((v) => v.navTitle === 'Landscape Detail', 20000)
    const g = await waitForGeometry('page-detail', (v) => v.systemInfo.deviceOrientation === 'landscape', 20000)
    expect(g.systemInfo.safeArea.top, 'no status bar in landscape means no top inset').toBe(0)
    expect(g.systemInfo.safeArea.left, 'the notch moves to the side edges in landscape').toBe(DEVICE.statusBarHeight)
  })

  /**
   * The CSS side of the same fact. `env(safe-area-inset-*)` is injected into the page's render guest by main, while `safeArea` is computed from the host-env snapshot in the service host — two processes, one orientation.
   * Resolving the CSS insets against the DEVICE orientation instead of the PAGE's is what this pins: on a portrait device a landscape-pinned page would be told sides of 0 in CSS while JS reports 44, and a layout written against `env(safe-area-inset-left)` would slide under the notch.
   */
  test('CSS env(safe-area-inset-*) agrees with the page safeArea on a page-level landscape page', async () => {
    await resetToTab1()
    await tapInGuest('page-tab1', '.goto-detail-btn')
    await waitForShell((v) => v.navTitle === 'Landscape Detail', 20000)
    const g = await waitForGeometry('page-detail', (v) => v.systemInfo.deviceOrientation === 'landscape', 20000)

    // `safeArea` is a rect on the oriented screen; the insets are its margins.
    const { screenWidth, screenHeight, safeArea } = g.systemInfo
    const fromJs = {
      top: safeArea.top,
      right: screenWidth - safeArea.right,
      bottom: screenHeight - safeArea.bottom,
      left: safeArea.left,
    }
    // The page is landscape on a portrait device, so this must NOT be the device's own portrait answer — otherwise the comparison below could pass with both sides wrong in the same way.
    expect(fromJs, 'the landscape notch sits on both side edges, not the top').toEqual({
      top: 0,
      right: DEVICE.statusBarHeight,
      bottom: 21,
      left: DEVICE.statusBarHeight,
    })

    const fromCss = await pollUntil(
      () => readGuest<Record<string, string>>(
        'page-detail',
        `(() => { const s = getComputedStyle(document.querySelector('.probe-env'));
          return { top: s.paddingTop, right: s.paddingRight, bottom: s.paddingBottom, left: s.paddingLeft } })()`,
      ),
      (v) => !!v && v.left !== '0px',
      15000,
      250,
    )
    expect(fromCss, 'the page must resolve env(safe-area-inset-*) to real values').toBeTruthy()
    expect({
      top: parseFloat(fromCss!.top),
      right: parseFloat(fromCss!.right),
      bottom: parseFloat(fromCss!.bottom),
      left: parseFloat(fromCss!.left),
    }, 'CSS env(safe-area-inset-*) must describe the same orientation as wx.getSystemInfoSync().safeArea')
      .toEqual(fromJs)

    await shot('11-landscape-detail-css-env-insets')
  })

  test('a mini-app forcing landscape never writes back to a portrait device', async () => {
    await resetToTab1()
    await tapInGuest('page-tab1', '.goto-detail-btn')
    await waitForShell((v) => v.navTitle === 'Landscape Detail', 20000)
    await waitForGeometry('page-detail', (v) => v.systemInfo.deviceOrientation === 'landscape', 20000)

    await closeProject(mainWindow)
    expect(
      (await ipcInvoke<{ deviceOrientation?: string } | null>(mainWindow, SimulatorChannel.GetDeviceInfo))?.deviceOrientation,
      'closing a project must leave the simulated device on its own orientation',
    ).toBe('portrait')

    // The user-visible proof: reopening draws the `auto` entry tab portrait.
    await openProjectInUI(mainWindow, FIXTURE_DIR, { waitMs: 40000 })
    await waitSimulatorReady(electronApp)
    const s = await waitForShell((v) => !!v.tabBar && v.navTitle === 'Tab One', 40000)
    expect(s.screen, 'the device is still portrait after the landscape session ended')
      .toEqual({ width: DEVICE.width, height: DEVICE.height })
    await expect(
      rotateButton(),
      'the rotate control is usable again on the auto entry page',
    ).toBeEnabled({ timeout: 10000 })
  })

  test('a mini-app forcing portrait never writes back to a landscape device', async () => {
    await resetToTab1()
    await clickRotate()
    const rotated = await waitForShell(isLandscape)
    expect(rotated.screen!.width).toBeGreaterThan(rotated.screen!.height)
    await shot('08-landscape-device-tab1')

    await tapInGuest('page-tab1', '.goto-portrait-btn')
    await waitForShell((v) => v.navTitle === 'Fixed Portrait', 20000)
    const forced = await waitForGeometry('page-portrait', (v) => v.systemInfo.deviceOrientation === 'portrait', 20000)
    expect(forced.systemInfo.screenWidth, 'a fixed-portrait page renders portrait on a landscape device')
      .toBe(DEVICE.width)
    expect(forced.systemInfo.screenHeight).toBe(DEVICE.height)
    await shot('09-portrait-forced-page-on-landscape-device')

    await closeProject(mainWindow)
    expect(
      (await ipcInvoke<{ deviceOrientation?: string } | null>(mainWindow, SimulatorChannel.GetDeviceInfo))?.deviceOrientation,
      'the mini-app forcing portrait must not rotate the simulated device',
    ).toBe('landscape')

    await openProjectInUI(mainWindow, FIXTURE_DIR, { waitMs: 40000 })
    await waitSimulatorReady(electronApp)
    const reopened = await waitForShell((v) => !!v.tabBar && v.navTitle === 'Tab One', 40000)
    expect(reopened.screen, 'the device is still landscape after the portrait-forcing session ended')
      .toEqual({ width: DEVICE.height, height: DEVICE.width })
    expectChromeInsideScreen(reopened)
    expectNoTabBarOverlap(reopened)
    await shot('10-landscape-tab1-after-reopen')

    // Leave the shared device state as the suite found it.
    await clickRotate()
    await waitForShell((v) => !isLandscape(v))
  })

  /**
   * `wx.hideTabBar` unmounts the bar and the page viewport grows into its space, so the call changes the window the mini-app reports.
   * Its success callback is entitled to read that new window: the shell commits the tab-bar state and publishes the new geometry BEFORE it acks the call, so by the time the callback runs main's host-env snapshot already describes the grown page. `showTabBar` is the same fact in reverse.
   */
  test('hideTabBar / showTabBar report the new window height inside their own success callback', async () => {
    await resetToTab1()
    // The previous test ends by rotating the device back to portrait, and Page.onResize now settles through a 16ms merge window (see dimina/fe/packages/service/src/core/runtime.js settleResize), so the page's geometry probe can still be publishing the pre-rotate (landscape) snapshot for a few ms after resetToTab1() resolves. `windowHeight > 0` is true for either orientation, so pin the predicate to the orientation this suite actually reset to, or the probe's own stale reading becomes "baseline".
    const withBar = await waitForGeometry(
      'page-tab1',
      (v) => v.systemInfo.windowHeight > 0 && v.systemInfo.deviceOrientation === 'portrait',
    )
    const baseline = withBar.systemInfo.windowHeight
    const reserved = tabBarReservedHeight(BOTTOM_INSET)

    const readToggle = async (call: 'hideTabBar' | 'showTabBar'): Promise<number> => {
      const raw = await pollUntil(
        () => readGuest<string>('page-tab1', `(document.querySelector('.probe-tabbar-toggle') || {}).textContent || ''`),
        (v) => !!v && v.includes(`"${call}"`),
        15000,
        250,
      )
      return (JSON.parse(raw!) as { windowHeight: number }).windowHeight
    }

    await tapInGuest('page-tab1', '.hide-tabbar-btn')
    expect(
      await readToggle('hideTabBar'),
      'the success callback must already see the viewport the bar just gave back',
    ).toBe(baseline + reserved)
    const hidden = await waitForShell((v) => !v.tabBar)
    expect(hidden.viewport?.height, 'the shell itself grew the page area too').toBe(baseline + reserved)
    await shot('12-portrait-tab1-tabbar-hidden')

    await tapInGuest('page-tab1', '.show-tabbar-btn')
    expect(
      await readToggle('showTabBar'),
      'showing the bar takes the height back before the caller is told it succeeded',
    ).toBe(baseline)
    const shown = await waitForShell((v) => !!v.tabBar)
    expect(shown.viewport?.height).toBe(baseline)
    expectNoTabBarOverlap(shown)
  })
})
