/**
 * E2E (native-host, real user input): a `bindtap` handler that calls
 * `wx.navigateTo` must still navigate after `reLaunch` has torn down the
 * launch page.
 *
 * Why this needs a REAL click through Electron's input pipeline, not
 * automator's synthesised tap: the service host serves the session's whole
 * page stack and carries no page identity of its own — every wx API call it
 * issues is resolved against a live page at receipt time (the message names
 * one explicitly, or it falls back to the session's active page).
 * `reLaunch`ing back to the SAME route (`pages/home/home`) still disposes the
 * launch page and opens a brand-new page session for it (a fresh bridgeId),
 * while the service host itself is reused. So after a reLaunch, any wx API
 * call the service issues — including one triggered by a real tap on the NEW
 * home page's button — must resolve against the new active page rather than
 * the disposed launch page. The render→service leg (RENDER_PUBLISH, carrying
 * the render guest's OWN current bridgeId) is unaffected; only the resulting
 * SERVICE_INVOKE for `wx.navigateTo` depends on active-page resolution.
 * automator's synthesised tap goes through a different call path that never
 * exercises this real DOM/bridge relay, so it cannot reproduce a routing
 * regression here.
 *
 * Fixture: e2e/fixtures/tabbar-app — `pages/home/home` (entry) renders
 * `<button class="btn nav-detail-btn" bindtap="goDetail">`, whose handler
 * calls `wx.navigateTo({ url: '/pages/detail/detail' })`.
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
  RENDER_GUEST_URL_MARKER,
  findMainWindow,
} from './helpers'
import { AutomationChannel } from '../src/shared/ipc-channels'

// NOTE: scope DIMINA_NATIVE_HOST to THIS spec's electron launch, never
// `process.env` — a module-top mutation poisons the shared --workers=1
// runner, flipping every other spec into native-host mode.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = path.resolve(__dirname, 'fixtures', 'tabbar-app')

const HOME_ROUTE = 'pages/home/home'
const DETAIL_ROUTE = 'pages/detail/detail'
// `buildRenderHostDocumentUrl` percent-encodes the pagePath query value, so
// the '/' separators show up as %2F in the render guest's URL.
const HOME_PAGEPATH_MARKER = 'pagePath=pages%2Fhome%2Fhome'
const DETAIL_PAGEPATH_MARKER = 'pagePath=pages%2Fdetail%2Fdetail'

let electronApp: ElectronApplication
let mainWindow: PwPage
let autoPort = 0

/** One-shot JSON-RPC call to the miniprogram-automator WebSocket server (mirrors native-host-current-page.spec.ts). */
function wsCall<T = Record<string, unknown>>(
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 12000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${autoPort}`)
    const timer = setTimeout(() => { ws.close(); reject(new Error(`wsCall ${method} timed out`)) }, timeoutMs)
    ws.on('open', () => ws.send(JSON.stringify({ id: 'nhrl1', method, params })))
    ws.on('message', (raw) => {
      let msg: { id?: string; result?: unknown; error?: { message?: string } }
      try { msg = JSON.parse(String(raw)) } catch { return }
      if (msg.id !== 'nhrl1') return
      clearTimeout(timer)
      ws.close()
      if (msg.error) reject(new Error(msg.error.message || 'rpc error'))
      else resolve(msg.result as T)
    })
    ws.on('error', (err) => { clearTimeout(timer); reject(err) })
  })
}

/** URLs of live (non-destroyed) render-guest webContents matching a pagePath marker. */
async function liveRenderGuestUrls(pagePathMarker: string): Promise<string[]> {
  return electronApp.evaluate(({ webContents }, payload) => {
    return webContents.getAllWebContents()
      .filter((wc) => !wc.isDestroyed()
        && wc.getURL().includes(payload.guestMarker)
        && wc.getURL().includes(payload.pathMarker))
      .map((wc) => wc.getURL())
  }, { guestMarker: RENDER_GUEST_URL_MARKER, pathMarker: pagePathMarker })
}

function extractBridgeId(url: string): string | null {
  const m = /[?&]bridgeId=([^&]+)/.exec(url)
  return m ? m[1] : null
}

/**
 * Click through Electron's own input pipeline instead of the automation
 * protocol's synthesised tap (see automator-label-semantics.spec.ts's
 * `trustedClick`) — only a real DOM event exercises the render guest's own
 * touch→bindtap relay into the service host, the leg this spec depends on to
 * reach the SERVICE_INVOKE the bug lives in.
 */
async function trustedClickNavDetailButton(bridgeId: string): Promise<void> {
  await electronApp.evaluate(async ({ webContents }, payload) => {
    const target = webContents.getAllWebContents().find(
      (wc) => !wc.isDestroyed()
        && wc.getURL().includes(payload.guestMarker)
        && wc.getURL().includes(`bridgeId=${payload.bridgeId}`),
    )
    if (!target) throw new Error(`render guest webContents not found for bridgeId ${payload.bridgeId}`)
    const json = await target.executeJavaScript(`(() => {
      const el = document.querySelector('.nav-detail-btn')
      if (!el) return 'null'
      const r = el.getBoundingClientRect()
      return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 })
    })()`) as string
    if (json === 'null') throw new Error('.nav-detail-btn not found in render guest')
    const point = JSON.parse(json) as { x: number, y: number }
    const base = { x: Math.round(point.x), y: Math.round(point.y), button: 'left' as const, clickCount: 1 }
    target.sendInputEvent({ ...base, type: 'mouseMove' })
    target.sendInputEvent({ ...base, type: 'mouseDown' })
    await new Promise((r) => setTimeout(r, 40))
    target.sendInputEvent({ ...base, type: 'mouseUp' })
  }, { guestMarker: RENDER_GUEST_URL_MARKER, bridgeId })
}

/** Each mounted DeviceShell page `<webview>`'s src + computed display, read from the simulator's own DOM. */
async function deviceShellWebviewDisplays(): Promise<Array<{ src: string, display: string }>> {
  return evalInSimulator<Array<{ src: string, display: string }>>(
    electronApp,
    `Array.from(document.querySelectorAll('.device-shell__webview')).map((el) => ({
      src: el.getAttribute('src') || '',
      display: getComputedStyle(el).display,
    }))`,
  )
}

test.describe('native-host reLaunch then real-click navigateTo e2e', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(180_000)

  test.beforeAll(async () => {
    const appPath = path.resolve(__dirname, 'electron-entry.js')
    const userDataDir = path.resolve(
      process.env.DIMINA_DEVTOOLS_DATA_DIR
        ?? path.resolve(__dirname, '..', 'node_modules', '.cache', 'devtools-e2e'),
      'userdata',
      `nh-relaunch-nav-${process.pid}`,
    )
    fs.mkdirSync(userDataDir, { recursive: true })

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

    autoPort = await pollUntil(
      () => ipcInvoke<number | null>(mainWindow, AutomationChannel.GetPort),
      (val) => typeof val === 'number' && val > 0,
      10000,
      100,
    ) as number

    await openProjectInUI(mainWindow, FIXTURE_DIR, { waitMs: 20000 })
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

    // Render guest ready: the entry page's own frame has attached.
    await pollUntil(
      () => liveRenderGuestUrls(HOME_PAGEPATH_MARKER),
      (urls) => urls.length >= 1,
      25000,
      300,
    )
  })

  test.afterAll(async () => {
    await closeProject(mainWindow).catch(() => {})
    await electronApp?.close().catch(() => {})
  })

  test('a real tap on the reLaunched home page still drives wx.navigateTo to the detail page', async () => {
    // Sanity: automation reports the entry page before doing anything.
    const before = await pollUntil(
      () => wsCall<{ path?: string }>('App.getCurrentPage').catch(() => null),
      (r) => !!r && typeof r.path === 'string' && r.path.includes(HOME_ROUTE),
      20000,
      500,
    )
    expect(before?.path, 'app should start on the entry route').toContain(HOME_ROUTE)

    const beforeUrls = await pollUntil(
      () => liveRenderGuestUrls(HOME_PAGEPATH_MARKER),
      (urls) => urls.length >= 1,
      15000,
      300,
    )
    const bridgeIdBefore = extractBridgeId(beforeUrls[0]!)
    expect(bridgeIdBefore, 'the launch page render guest URL must carry a bridgeId').toBeTruthy()

    // reLaunch back to the SAME route: still tears down the launch page and
    // opens a brand-new page session for it — the service host itself is
    // reused and carries no page identity, so its next SERVICE_INVOKE must
    // resolve against whichever page is active now, not the disposed launch page.
    await wsCall('App.callWxMethod', { method: 'reLaunch', args: [{ url: '/' + HOME_ROUTE }] })

    await pollUntil(
      () => wsCall<{ path?: string }>('App.getCurrentPage').catch(() => null),
      (r) => !!r && typeof r.path === 'string' && r.path.includes(HOME_ROUTE),
      15000,
      500,
    )

    // Confirm the launch page's session was actually replaced (new bridgeId),
    // not just re-rendered in place — this is the precondition the drop
    // depends on.
    const afterUrls = await pollUntil(
      () => liveRenderGuestUrls(HOME_PAGEPATH_MARKER),
      (urls) => urls.some((u) => extractBridgeId(u) && extractBridgeId(u) !== bridgeIdBefore),
      20000,
      400,
    )
    const bridgeIdAfter = extractBridgeId(afterUrls.find((u) => extractBridgeId(u) !== bridgeIdBefore)!)
    expect(bridgeIdAfter, 'reLaunch must replace the launch page with a new bridge session').toBeTruthy()
    expect(bridgeIdAfter).not.toBe(bridgeIdBefore)

    // The user-visible action under test: a real click (not a synthesised
    // automator tap) on the NEW home page's button.
    await trustedClickNavDetailButton(bridgeIdAfter!)

    // Final screen: the detail page's webview must actually become visible,
    // and home's must be hidden — the drop this spec pins looks like nothing
    // happening at all, so the assertion has to be the rendered outcome, not
    // just an RPC acknowledgement.
    const displays = await pollUntil(
      () => deviceShellWebviewDisplays(),
      (rows) => rows.some((r) => r.src.includes(DETAIL_PAGEPATH_MARKER) && r.display === 'flex'),
      20000,
      400,
    )
    const detailRow = displays.find((r) => r.src.includes(DETAIL_PAGEPATH_MARKER))
    const homeRow = displays.find((r) => r.src.includes(HOME_PAGEPATH_MARKER))
    expect(detailRow?.display, 'the detail page webview must be visible after the click-driven navigateTo').toBe('flex')
    expect(homeRow?.display, 'the home page webview must be hidden once detail becomes the active page').toBe('none')

    // Control: automation's own route tracking agrees the app moved to detail.
    const moved = await pollUntil(
      () => wsCall<{ path?: string }>('App.getCurrentPage').catch(() => null),
      (r) => !!r && typeof r.path === 'string' && r.path.includes(DETAIL_ROUTE),
      10000,
      400,
    )
    expect(moved?.path).toContain(DETAIL_ROUTE)
  })
})
