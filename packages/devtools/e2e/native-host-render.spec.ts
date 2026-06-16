/**
 * E2E: the simulator RENDERER actually runs the native-host path (DeviceShell +
 * render-host <webview>s) under DIMINA_NATIVE_HOST=1, not the default dimina-fe
 * container.
 *
 * The render-host page content lives in a nested, cross-process <webview> whose
 * inner document the simulator context can't read, so we assert the reachable,
 * DISCRIMINATING facts: DeviceShell's `.device-shell-root` mounts and at least
 * one `.device-shell__webview` (a class the default dimina-fe path never emits)
 * is created with a render-host `src`. That proves the preload installed the
 * native-host bridge, SimulatorMiniApp.spawn() resolved, and DeviceShell painted.
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
  evalInWebContentsByUrl,
} from './helpers'
import {
  AutomationChannel,
  SimulatorAppDataChannel,
  SimulatorElementChannel,
  SimulatorStorageChannel,
  SimulatorWxmlChannel,
} from '../src/shared/ipc-channels'

// NOTE: scope DIMINA_NATIVE_HOST to THIS spec's electron launch (below), never
// `process.env` — a module-top mutation poisons the shared --workers=1 runner,
// flipping every other spec into native-host mode (panel ripple → mass failures).

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = path.resolve(__dirname, 'fixtures', 'tabbar-app')

let electronApp: ElectronApplication
let mainWindow: PwPage
let autoPort = 0

// One-shot JSON-RPC call to the miniprogram-automator WebSocket server. Drives
// the SAME automation handlers the SDK uses, so it exercises the native-host
// automation pipeline (App/Page/Element → evalInActivePage → render guest /
// serviceWc) end-to-end. Mirrors the helper in automator-compat.spec.ts.
function wsCall<T = Record<string, unknown>>(
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 12000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${autoPort}`)
    const timer = setTimeout(() => { ws.close(); reject(new Error(`wsCall ${method} timed out`)) }, timeoutMs)
    ws.on('open', () => ws.send(JSON.stringify({ id: 'nh1', method, params })))
    ws.on('message', (raw) => {
      let msg: { id?: string; result?: unknown; error?: { message?: string } }
      try { msg = JSON.parse(String(raw)) } catch { return }
      if (msg.id !== 'nh1') return
      clearTimeout(timer)
      ws.close()
      if (msg.error) reject(new Error(msg.error.message || 'rpc error'))
      else resolve(msg.result as T)
    })
    ws.on('error', (err) => { clearTimeout(timer); reject(err) })
  })
}

test.describe('native-host render path e2e', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(180_000)

  test.beforeAll(async () => {
    const appPath = path.resolve(__dirname, 'electron-entry.js')
    const userDataDir = path.resolve(
      process.env.DIMINA_DEVTOOLS_DATA_DIR
        ?? path.resolve(__dirname, '..', 'node_modules', '.cache', 'devtools-e2e'),
      'userdata',
      `nh-render-${process.pid}`,
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
  })

  test.afterAll(async () => {
    await closeProject(mainWindow).catch(() => {})
    await electronApp?.close().catch(() => {})
  })

  test('renderer boots DeviceShell + render-host webviews under native-host', async () => {
    // DeviceShell mounts only after SimulatorMiniApp.spawn() resolves (IPC:
    // service host + resource server spin up first), so poll generously.
    const shellMounted = await pollUntil(
      () => evalInSimulator<boolean>(
        electronApp,
        `(() => !!document.querySelector('.device-shell-root'))()`,
      ).catch(() => false),
      (ok) => ok === true,
      25000,
      300,
    )
    expect(shellMounted, 'DeviceShell .device-shell-root should mount under DIMINA_NATIVE_HOST=1').toBe(true)

    // `.device-shell__webview` is exclusive to the native render path — the
    // default dimina-fe container never emits it. Load-bearing discriminator.
    const webviewCount = await pollUntil(
      () => evalInSimulator<number>(
        electronApp,
        `(() => document.querySelectorAll('.device-shell__webview').length)()`,
      ).catch(() => 0),
      (n) => n >= 1,
      25000,
      300,
    )
    expect(webviewCount, 'at least one render-host <webview> should exist').toBeGreaterThanOrEqual(1)

    // The webview points at the render host with a spawn-allocated bridgeId,
    // proving SimulatorMiniApp.spawn() + createRenderHostUrl ran.
    const src = await evalInSimulator<string>(
      electronApp,
      `(() => { const w = document.querySelector('.device-shell__webview'); return w ? (w.getAttribute('src') || '') : '' })()`,
    )
    expect(src).toContain('render-host')
    expect(src).toContain('pageFrame.html')
    expect(src).toContain('bridgeId=')
  })

  // ── Right-panel + storage parity under native-host ──────────────────────────
  // These drive the SAME main-process IPC the renderer panels consume, so they
  // validate the whole native-host data pipeline end-to-end in real Electron:
  // WXML (renderWc.executeJavaScript → __diminaRenderInspect), AppData (the
  // service→render setData tap), and Storage (the unified service-host file://
  // store). The default dimina-fe path doesn't register these channels.

  // The simulator now mounts as a top-level WebContentsView (Option A), so its
  // webContents is NOT a webview guest and CAN host DeviceShell's per-page
  // render-host `<webview>`s — the pages render, so these panels have a real
  // active page to read end-to-end.
  test('WXML panel is populated from the active render guest', async () => {
    // The WXML service pulls the tree from the active render guest via the
    // injected inspector; it's ready once the page DOM (its Vue tree) mounts.
    const tree = await pollUntil(
      () => ipcInvoke<{ tagName?: string } | null>(mainWindow, SimulatorWxmlChannel.GetSnapshot).catch(() => null),
      (t) => !!t && typeof t.tagName === 'string',
      30000,
      400,
    )
    expect(tree, 'WXML GetSnapshot should return a non-null tree under native-host').toBeTruthy()
    expect(typeof (tree as { tagName?: string }).tagName).toBe('string')
  })

  test('AppData panel is populated from the service→render setData tap', async () => {
    const snap = await pollUntil(
      () => ipcInvoke<{ bridges?: unknown[] } | null>(mainWindow, SimulatorAppDataChannel.GetSnapshot).catch(() => null),
      (s) => !!s && Array.isArray(s.bridges) && s.bridges.length >= 1,
      30000,
      400,
    )
    expect(
      Array.isArray((snap as { bridges?: unknown[] })?.bridges) && (snap as { bridges: unknown[] }).bridges.length,
      'AppData GetSnapshot should report at least one page bridge',
    ).toBeGreaterThanOrEqual(1)
  })

  test('Storage panel reads/writes the service-host store', async () => {
    const prefix = await ipcInvoke<string>(mainWindow, SimulatorStorageChannel.GetActivePrefix)
    expect(prefix, 'active storage prefix should resolve under native-host').toBeTruthy()
    const key = `${prefix}__e2e_native_storage`

    const set = await ipcInvoke<{ ok: boolean }>(mainWindow, SimulatorStorageChannel.Set, { key, value: 'native-1' })
    expect(set?.ok, 'Set should succeed against the service-host store').toBe(true)

    const items = await pollUntil(
      () => ipcInvoke<Array<{ key: string; value: string }>>(mainWindow, SimulatorStorageChannel.GetSnapshot).catch(() => []),
      (arr) => Array.isArray(arr) && arr.some((it) => it.key === key && it.value === 'native-1'),
      10000,
      300,
    )
    expect(items.some((it) => it.key === key && it.value === 'native-1'), 'written key should appear in the snapshot').toBe(true)
  })

  // ── Automation parity under native-host (raw JSON-RPC over the WS server) ────
  // These drive the real miniprogram-automator handlers, which under native-host
  // route through evalInActivePage → the active render-host guest (Page/Element)
  // or serviceWc.executeJavaScript('wx.*') (nav). They prove the automation +
  // AppData + console pipelines work against the real rendered page, not the
  // default dimina-fe iframe (which native-host doesn't use).

  test('Page.getData returns the active page reactive data via the central accumulator', async () => {
    // The home fixture page declares `data: { pageName, counter, profile }`. Under
    // native-host this flows service→render and is tapped into the AppData
    // accumulator; Page.getData reads it back (the old stub always returned {}).
    const full = await pollUntil(
      () => wsCall<{ data?: Record<string, unknown> }>('Page.getData', {}).catch(() => null),
      (r) => !!r && !!r.data && typeof r.data === 'object' && Object.keys(r.data).length > 0,
      30000,
      500,
    )
    expect(full?.data, 'Page.getData should return the home page reactive data').toBeTruthy()
    expect(full!.data!.pageName).toBe('home')
    expect(full!.data!.counter).toBe(7)

    // Path traversal mirrors the default branch: nested + bracket paths resolve,
    // a missing key resolves to undefined (no throw).
    const nick = await wsCall<{ data?: unknown }>('Page.getData', { path: 'profile.nick' })
    expect(nick.data).toBe('tester')
    const counter = await wsCall<{ data?: unknown }>('Page.getData', { path: 'counter' })
    expect(counter.data).toBe(7)
    const bogus = await wsCall<{ data?: unknown }>('Page.getData', { path: '__definitely_missing_key__' })
    expect(bogus.data).toBeUndefined()
  })

  test('element inspection resolves a real element rect from the active render guest', async () => {
    // The render inspector (render-inspect IIFE in the guest main world) backs
    // both the WXML tree and element highlight. Walk the tree for sids, then
    // highlight until one maps to a real, laid-out element.
    const tree = await pollUntil(
      () => ipcInvoke<{ tagName?: string; sid?: string; children?: unknown[] } | null>(
        mainWindow, SimulatorWxmlChannel.GetSnapshot,
      ).catch(() => null),
      (t) => !!t && typeof t.tagName === 'string',
      30000,
      400,
    )
    const sids: string[] = []
    const walk = (n: { sid?: string; children?: unknown[] } | null | undefined): void => {
      if (!n) return
      if (typeof n.sid === 'string' && n.sid) sids.push(n.sid)
      for (const c of (n.children ?? []) as Array<{ sid?: string; children?: unknown[] }>) walk(c)
    }
    walk(tree as { sid?: string; children?: unknown[] })
    expect(sids.length, 'WXML tree should expose sids to inspect').toBeGreaterThan(0)

    let hit: { rect?: { width?: number } } | null = null
    for (const sid of sids.slice(0, 30)) {
      const r = await ipcInvoke<{ rect?: { width?: number } } | null>(
        mainWindow, SimulatorElementChannel.Inspect, sid,
      ).catch(() => null)
      if (r && r.rect) { hit = r; break }
    }
    expect(hit, 'at least one sid should highlight a real element via the render inspector').toBeTruthy()
    expect(typeof hit!.rect!.width).toBe('number')
    await ipcInvoke(mainWindow, SimulatorElementChannel.Clear).catch(() => {})
  })

  test('App.getCurrentPage + Page.getElement/Element.tap reach the render guest', async () => {
    const cur = await pollUntil(
      () => wsCall<{ path?: string }>('App.getCurrentPage').catch(() => null),
      (r) => !!r && typeof r.path === 'string' && r.path.length > 0,
      20000,
      500,
    )
    expect(cur?.path, 'App.getCurrentPage should report the active native page path').toContain('pages/')

    // Page.getElement('body') reads the render guest's DOM via evalInActivePage.
    const el = await wsCall<{ elementId?: string; tagName?: string }>('Page.getElement', { selector: 'body' })
    expect(el.tagName).toBe('body')
    expect(el.elementId, 'getElement should register an elementId').toBeTruthy()

    // Element.tap round-trips through evalInElement → renderWc (no throw).
    await wsCall('Element.tap', { elementId: el.elementId })
  })

  test('App.callWxMethod switchTab navigates the active page (service-host wx.*)', async () => {
    const start = await wsCall<{ path?: string }>('App.getCurrentPage')
    const target = (start.path ?? '').includes('cart') ? 'pages/home/home' : 'pages/cart/cart'
    const marker = target.split('/')[1] // 'cart' or 'home'

    await wsCall('App.callWxMethod', { method: 'switchTab', args: [{ url: '/' + target }] })

    const after = await pollUntil(
      () => wsCall<{ path?: string }>('App.getCurrentPage').catch(() => null),
      (r) => !!r && typeof r.path === 'string' && r.path.includes(marker),
      15000,
      500,
    )
    expect(after?.path, `switchTab should move the active page to ${target}`).toContain(marker)
  })

  test('render-guest console.log is forwarded to the automation WS as App.logAdded', async () => {
    const marker = `__e2e_native_console_${Date.now()}__`
    const ws = new WebSocket(`ws://127.0.0.1:${autoPort}`)
    const logs: Array<{ args?: unknown[] }> = []
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
    })
    ws.on('message', (raw) => {
      try {
        const m = JSON.parse(String(raw)) as { method?: string; params?: { args?: unknown[] } }
        if (m.method === 'App.logAdded' && m.params) logs.push(m.params)
      } catch { /* ignore */ }
    })
    // Let the server register this client before emitting.
    await new Promise((r) => setTimeout(r, 300))

    // Fire console.log inside the active render-host guest (pageFrame.html). Its
    // preload monkeypatches console → bridge-router → ctx.guestConsole → broadcast.
    await evalInWebContentsByUrl(electronApp, 'pageFrame.html', `console.log(${JSON.stringify(marker)}); 1`)

    const found = await pollUntil(
      async () => logs.some((p) => JSON.stringify(p.args ?? []).includes(marker)),
      (ok) => ok === true,
      15000,
      300,
    )
    ws.close()
    expect(found, 'render-host console.log should reach the automation WS via the native-host console tap').toBe(true)
  })

  test('layout: the native simulator WebContentsView is live with the default zoom', async () => {
    // The simulator is a top-level WebContentsView (Option A). Confirm it exists
    // and carries the default 85% zoom factor (setZoomFactor wired, not broken).
    // Pixel-position fidelity (bezel inset, scroll/splitter tracking) is visual QA.
    const zoom = await electronApp.evaluate(({ webContents }) => {
      const sim = webContents.getAllWebContents().find((wc) => wc.getURL().includes('simulator.html'))
      return sim ? sim.getZoomFactor() : null
    })
    expect(zoom, 'native simulator WebContentsView should be present').not.toBeNull()
    expect(Math.abs((zoom as number) - 0.85), 'default zoom factor should be ~0.85').toBeLessThan(0.01)
  })
})
