/**
 * E2E (native-host): window metrics follow the selected device WITHOUT
 * restarting the mini-app, and the safe-area top a page sees depends on its
 * navigation-bar style.
 *
 * Real user path: toolbar <select> -> setNativeDeviceInfo IPC -> main process
 * host-env + `hostEnvUpdate` push into the RUNNING dimina service -> what the
 * page's own JS (`wx.getWindowInfo` / `wx.getSystemInfo(Sync)`) and the page's
 * own CSS (`env(safe-area-inset-*)`) observe.
 *
 * Expected numbers:
 * - iPhone 15 portrait values are written out literally, straight from
 *   FIX-SPEC-window-info.md I1's worked example (screen 393x852, statusBar 54,
 *   insets top 59 / bottom 34 in @devicekit/devices). Spelling them out is
 *   deliberate: importing `deviceInfoToHostEnv` here would make the spec agree
 *   with the implementation by construction instead of pinning the contract.
 *   Before the fix `wx.getWindowInfo()` answered with the spawn-time iPhone X
 *   constants {375, 812, 375, 768, 44} and had no safeArea/screenTop at all.
 * - The second device (Pixel 8) is read from the @devicekit/devices table and
 *   run through I1's formula, so a table edit can't silently desync the spec.
 */
import { test, expect, _electron, type ElectronApplication, type Page as PwPage } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import {
  openProjectInUI,
  waitForSimulatorWebview,
  waitSimulatorReady,
  closeProject,
  ipcInvoke,
  pollUntil,
  evalInSimulator,
  evalInWebContentsByUrl,
  RENDER_GUEST_URL_MARKER,
  findMainWindow,
} from './helpers'
import { AutomationChannel } from '../src/shared/ipc-channels'
import {
  DEVICE_NAMES,
  findDevice,
  resolveDevice,
  orientedScreen,
  safeAreaInsetsFor,
  statusBarHeightFor,
} from '@devicekit/devices'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = path.resolve(__dirname, 'fixtures', 'tabbar-app')
const SERVICE_URL_MARKER = 'service-host/service.html'

let electronApp: ElectronApplication
let mainWindow: PwPage
let workbench: PwPage

// ── Expected values ────────────────────────────────────────────────────
/** FIX-SPEC I1's worked example for iPhone 15 portrait. */
const IPHONE_15_WINDOW_INFO = {
  pixelRatio: 3,
  screenWidth: 393,
  screenHeight: 852,
  windowWidth: 393,
  windowHeight: 759,
  statusBarHeight: 54,
  safeArea: { left: 0, top: 59, right: 393, bottom: 818, width: 393, height: 759 },
  screenTop: 54,
}
/** env(safe-area-inset-*) the fixture's pages should see on iPhone 15
 *  portrait: default-nav pages start BELOW the navigation bar so their top
 *  inset is already consumed (I4); the bottom inset only applies where no tab
 *  bar covers it. */
const DEFAULT_NAV_TAB_INSETS = { top: '0px', bottom: '0px' }
const DEFAULT_NAV_NON_TAB_INSETS = { top: '0px', bottom: '34px' }
const CUSTOM_NAV_INSETS = { top: '59px', bottom: '34px' }

/** The fields the three code paths (sync binding, async simulator handler,
 *  spawn snapshot) must agree on — FIX-SPEC I3. */
type WindowFields = Pick<
  typeof IPHONE_15_WINDOW_INFO,
  'screenWidth' | 'screenHeight' | 'windowWidth' | 'windowHeight' | 'statusBarHeight' | 'safeArea' | 'screenTop'
>

function windowFieldsOf(info: Record<string, unknown>): WindowFields {
  return {
    screenWidth: info.screenWidth as number,
    screenHeight: info.screenHeight as number,
    windowWidth: info.windowWidth as number,
    windowHeight: info.windowHeight as number,
    statusBarHeight: info.statusBarHeight as number,
    safeArea: info.safeArea as WindowFields['safeArea'],
    screenTop: info.screenTop as number,
  }
}

const IPHONE_15_SHARED_FIELDS = windowFieldsOf(IPHONE_15_WINDOW_INFO)

// ── Toolbar driving ────────────────────────────────────────────────────
async function selectDevice(win: PwPage, deviceName: string): Promise<void> {
  const sel = win.locator('select', { has: win.locator(`option[value="${deviceName}"]`) }).first()
  await sel.selectOption(deviceName)
}

async function waitForFrameDevice(app: ElectronApplication, deviceName: string): Promise<void> {
  await pollUntil(
    () => evalInSimulator<string | null>(app, `(() => {
      const el = document.querySelector('device-frame')
      return el ? el.getAttribute('device') : null
    })()`).catch(() => null),
    (name) => name === deviceName,
    15000,
    300,
  )
}

// ── service-host readbacks ─────────────────────────────────────────────
/** `wx.getWindowInfo()` called synchronously inside the running service, the
 *  way a page's own JS calls it. Serialized whole so nothing is dropped. */
async function readWindowInfo(app: ElectronApplication): Promise<Record<string, unknown>> {
  const json = await evalInWebContentsByUrl<string>(app, SERVICE_URL_MARKER, `(() => {
    const w = globalThis.wx
    if (!w || typeof w.getWindowInfo !== 'function') throw new Error('wx.getWindowInfo missing')
    return JSON.stringify(w.getWindowInfo())
  })()`)
  return JSON.parse(json) as Record<string, unknown>
}

async function readSystemInfoSync(app: ElectronApplication): Promise<Record<string, unknown>> {
  const json = await evalInWebContentsByUrl<string>(app, SERVICE_URL_MARKER, `(() => {
    const w = globalThis.wx
    if (!w || typeof w.getSystemInfoSync !== 'function') throw new Error('wx.getSystemInfoSync missing')
    return JSON.stringify(w.getSystemInfoSync())
  })()`)
  return JSON.parse(json) as Record<string, unknown>
}

/**
 * Async `wx.getSystemInfo({ success })`. Every settlement path is collected
 * over a fixed window rather than first-wins: in this runtime the returned
 * promise resolves `undefined` while the real payload arrives on `success`,
 * so a naive `await` would read nothing.
 */
async function readSystemInfoAsync(app: ElectronApplication): Promise<{
  success?: Record<string, unknown>
  events: Array<{ tag: string; res: unknown }>
}> {
  const json = await evalInWebContentsByUrl<string>(app, SERVICE_URL_MARKER, `(() => {
    const w = globalThis.wx
    if (!w || typeof w.getSystemInfo !== 'function') throw new Error('wx.getSystemInfo missing')
    return new Promise((resolve) => {
      const events = []
      setTimeout(() => resolve(JSON.stringify({ events })), 6000)
      try {
        const ret = w.getSystemInfo({
          success: (res) => events.push({ tag: 'success', res }),
          fail: (res) => events.push({ tag: 'fail', res }),
        })
        if (ret && typeof ret.then === 'function') {
          ret.then(
            (res) => events.push({ tag: 'promise', res: res === undefined ? null : res }),
            (err) => events.push({ tag: 'promise-reject', res: String(err) }),
          )
        }
      } catch (err) {
        events.push({ tag: 'threw', res: String(err) })
      }
    })
  })()`)
  const parsed = JSON.parse(json) as { events: Array<{ tag: string; res: unknown }> }
  const success = parsed.events.find((e) => e.tag === 'success')
  return { success: success?.res as Record<string, unknown> | undefined, events: parsed.events }
}

async function navigateTo(app: ElectronApplication, url: string): Promise<void> {
  await evalInWebContentsByUrl(app, SERVICE_URL_MARKER, `(() => {
    globalThis.wx.navigateTo({ url: ${JSON.stringify(url)} })
    return true
  })()`)
}

// ── render-guest readbacks ─────────────────────────────────────────────
interface GuestInsets {
  /** First 60 chars of the guest's body text, used to tell page guests apart. */
  marker: string
  /** env(safe-area-inset-*) read off a probe this spec injects. */
  probeTop: string
  probeBottom: string
  /** Same values read off the fixture page's OWN CSS, where it has probes
   *  (pages/custom/custom.wxss) — the actual user path for env(). */
  pageTop: string | null
  pageBottom: string | null
}

const GUEST_INSETS_EXPR = `(() => {
  const probe = document.createElement('div')
  probe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;'
    + 'padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom);'
  document.body.appendChild(probe)
  const cs = getComputedStyle(probe)
  const pageTopEl = document.querySelector('.safe-probe-top')
  const pageBottomEl = document.querySelector('.safe-probe-bottom')
  const out = {
    marker: (document.body ? document.body.innerText : '').slice(0, 60),
    probeTop: cs.paddingTop,
    probeBottom: cs.paddingBottom,
    pageTop: pageTopEl ? getComputedStyle(pageTopEl).paddingTop : null,
    pageBottom: pageBottomEl ? getComputedStyle(pageBottomEl).paddingBottom : null,
  }
  probe.remove()
  return out
})()`

/**
 * Measure EVERY live render-host guest. `evalInWebContentsByUrl` only reaches
 * the first match, which stops being the visible page the moment a
 * `wx.navigateTo` stacks a second guest. Each `executeJavaScript` races a
 * deadline because a call issued against a guest that is being torn down never
 * settles and would otherwise hang until the test timeout.
 */
async function measureAllGuests(app: ElectronApplication): Promise<GuestInsets[]> {
  return app.evaluate(async ({ webContents }, payload) => {
    const withDeadline = (promise: Promise<unknown>): Promise<unknown> => Promise.race([
      promise,
      new Promise((resolve) => setTimeout(() => resolve(null), 3000)),
    ])
    const guests = webContents.getAllWebContents()
      .filter((wc) => !wc.isDestroyed() && wc.getURL().includes(payload.marker) && !wc.isLoading())
    const out: unknown[] = []
    for (const wc of guests) {
      const value = await withDeadline(wc.executeJavaScript(payload.expression))
      if (value) out.push(value)
    }
    return out
  }, { marker: RENDER_GUEST_URL_MARKER, expression: GUEST_INSETS_EXPR }) as Promise<GuestInsets[]>
}

/** Wait for the guest whose page content contains `text`, then hand it back. */
async function guestShowing(app: ElectronApplication, text: string): Promise<GuestInsets> {
  const guests = await pollUntil(
    () => measureAllGuests(app).catch(() => []),
    (list) => list.some((g) => g.marker.includes(text)),
    20000,
    500,
  )
  return guests.find((g) => g.marker.includes(text))!
}

test.describe('window info follows the selected device', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(240_000)

  test.beforeAll(async () => {
    const appPath = path.resolve(__dirname, 'electron-entry.js')
    const userDataDir = path.resolve(
      process.env.DIMINA_DEVTOOLS_DATA_DIR
        ?? path.resolve(__dirname, '..', 'node_modules', '.cache', 'devtools-e2e'),
      'userdata',
      `window-info-${process.pid}`,
    )
    fs.mkdirSync(userDataDir, { recursive: true })

    // DIMINA_NATIVE_HOST is scoped to THIS launch, never `process.env` at
    // module scope — a top-level mutation would flip every other spec sharing
    // the --workers=1 runner into native-host mode.
    electronApp = await _electron.launch({
      args: [appPath, 'auto', '--auto-port', '0', `--user-data-dir=${userDataDir}`],
      env: { ...process.env, NODE_ENV: 'test', DIMINA_NATIVE_HOST: '1', DIMINA_E2E_USER_DATA_DIR: userDataDir },
    })

    mainWindow = await findMainWindow(electronApp)
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

    await pollUntil(
      () => ipcInvoke<number | null>(mainWindow, AutomationChannel.GetPort),
      (val) => typeof val === 'number' && val > 0,
      10000,
      100,
    )

    workbench = await openProjectInUI(electronApp, FIXTURE_DIR, { waitMs: 20000 })
    await waitForSimulatorWebview(electronApp)
    await pollUntil(
      () => evalInSimulator<boolean>(
        electronApp,
        `(() => !!document.querySelector('.device-shell-root'))()`,
      ).catch(() => false),
      (ok) => ok === true,
      25000,
      300,
    )
    await waitSimulatorReady(electronApp)

    // The mini-app booted on the toolbar's default device (iPhone X). Every
    // test below runs against iPhone 15 selected AFTERWARDS, with no restart —
    // that is the whole point: the running service must re-read the device.
    await selectDevice(workbench, DEVICE_NAMES.iPhone_15)
    await waitForFrameDevice(electronApp, DEVICE_NAMES.iPhone_15)
  })

  test.afterAll(async () => {
    await closeProject(electronApp).catch(() => {})
    await electronApp?.close().catch(() => {})
  })

  test('1. wx.getWindowInfo() reports the device selected after boot', async () => {
    const info = await pollUntil(
      () => readWindowInfo(electronApp).catch(() => null),
      (i) => i !== null && i.screenWidth === IPHONE_15_WINDOW_INFO.screenWidth,
      20000,
      400,
    )
    expect(
      info,
      'wx.getWindowInfo() must answer with the CURRENTLY selected device; '
      + 'the spawn-time iPhone X constants (375x812, statusBarHeight 44, no safeArea) mean '
      + 'the hostEnvUpdate push never reached the running service',
    ).toEqual(IPHONE_15_WINDOW_INFO)
  })

  test('2. wx.getSystemInfoSync() agrees with getWindowInfo on the window fields', async () => {
    const info = await readSystemInfoSync(electronApp)
    expect(windowFieldsOf(info)).toEqual(IPHONE_15_SHARED_FIELDS)
  })

  test('3. async wx.getSystemInfo() agrees with the sync answer', async () => {
    const { success, events } = await readSystemInfoAsync(electronApp)
    expect(
      success,
      `wx.getSystemInfo success never fired; settlement events: ${JSON.stringify(events)}`,
    ).toBeTruthy()
    expect(windowFieldsOf(success!)).toEqual(IPHONE_15_SHARED_FIELDS)
  })

  test('4. default-nav pages see no top inset; bottom inset only without a tab bar', async () => {
    // The tab page the app booted into.
    const home = await guestShowing(electronApp, 'HOME PAGE')
    expect(
      { top: home.probeTop, bottom: home.probeBottom },
      'tab page with the default navigation bar: guest already starts below the nav bar, '
      + 'and the tab bar covers the home indicator',
    ).toEqual(DEFAULT_NAV_TAB_INSETS)

    await navigateTo(electronApp, '/pages/detail/detail')
    const detail = await guestShowing(electronApp, 'DETAIL PAGE')
    expect(
      { top: detail.probeTop, bottom: detail.probeBottom },
      'non-tab page with the default navigation bar: no top inset, but the home indicator is exposed',
    ).toEqual(DEFAULT_NAV_NON_TAB_INSETS)
  })

  test('5. a navigationStyle:custom page sees the full top inset', async () => {
    await navigateTo(electronApp, '/pages/custom/custom')
    const custom = await guestShowing(electronApp, 'CUSTOM NAV PAGE')
    expect(
      { top: custom.probeTop, bottom: custom.probeBottom },
      'custom navigation bar: the page draws its own header, so it owns the cutout inset',
    ).toEqual(CUSTOM_NAV_INSETS)
    // The same numbers through the page's OWN wxss (pages/custom/custom.wxss
    // declares padding-top/bottom: env(safe-area-inset-*)), which is how a real
    // mini-app consumes env().
    expect(
      { top: custom.pageTop, bottom: custom.pageBottom },
      'the fixture page\'s own env()-based padding should resolve to the same insets',
    ).toEqual(CUSTOM_NAV_INSETS)
  })

  test('6. switching to a second device again moves the window info', async () => {
    const profile = findDevice(DEVICE_NAMES.Pixel_8)
    expect(profile, 'sanity: Pixel 8 must exist in the @devicekit/devices table').toBeTruthy()
    const resolved = resolveDevice(profile!)
    const screen = orientedScreen(profile!, 'portrait')
    const insets = safeAreaInsetsFor(resolved, 'portrait')
    const statusBarHeight = statusBarHeightFor(resolved, 'portrait')
    // FIX-SPEC I1's formula, re-derived here from the device table.
    const windowHeight = screen.height - insets.top - insets.bottom

    await selectDevice(workbench, DEVICE_NAMES.Pixel_8)
    await waitForFrameDevice(electronApp, DEVICE_NAMES.Pixel_8)

    const info = await pollUntil(
      () => readWindowInfo(electronApp).catch(() => null),
      (i) => i !== null && i.screenWidth === screen.width,
      20000,
      400,
    )
    expect(info).toEqual({
      pixelRatio: resolved.pixelRatio,
      screenWidth: screen.width,
      screenHeight: screen.height,
      windowWidth: screen.width,
      windowHeight,
      statusBarHeight,
      safeArea: {
        left: insets.left,
        top: insets.top,
        right: screen.width - insets.right,
        bottom: screen.height - insets.bottom,
        width: screen.width - insets.right - insets.left,
        height: windowHeight,
      },
      screenTop: statusBarHeight,
    })
    expect(
      info!.windowHeight,
      'windowHeight must stay screenHeight minus both vertical insets after the second switch',
    ).toBe(windowHeight)
  })
})
