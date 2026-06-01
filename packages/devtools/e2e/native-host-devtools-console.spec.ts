/**
 * E2E: under native-host, the right-panel Chrome "Console" DevTools must inspect
 * the VISIBLE MINI-APP PAGE — the active render-host guest (`pageFrame.html`) —
 * NOT the DeviceShell shell document (`simulator.html`).
 *
 * Native-host topology:
 *   - The mini-app shell renders in a top-level "DeviceShell" WebContentsView
 *     that loads `…/simulator.html`.
 *   - Each PAGE is a nested render-host `<webview>` guest loading `…/pageFrame.html`.
 *   - The visible page changes on navigation.
 *
 * The CONTRACT pinned here: the DevTools host attaches to the active render-host
 * guest (pageFrame.html), so its Console shows the PAGE's logs — and it does NOT
 * attach to the DeviceShell shell (simulator.html).
 *
 * RELIABLE OBSERVABLE SIGNAL — why NOT `isDevToolsOpened()`:
 *   In the headless `auto` e2e launch `webContents.isDevToolsOpened()` does NOT
 *   track the C4 attach at all. Probed in this Electron (41.2.1):
 *     - the active pageFrame guest (which HAS a DevTools host attached) reports
 *       `isDevToolsOpened() === false`,
 *     - the simulator.html shell reports `false`,
 *     - the only wc reporting `true` is an unrelated internal chrome window.
 *   So `isDevToolsOpened()` is unsatisfiable/non-discriminating here.
 *
 *   The signal that ACTUALLY flips is the `webContents.devToolsWebContents`
 *   getter. The impl attaches via `sourceWc.setDevToolsWebContents(host)` +
 *   `openDevTools(...)`; after that the source wc's `devToolsWebContents`
 *   references the host (non-null). Probed values:
 *     - active pageFrame guest:  `devToolsWebContents` → wc#3  (NON-NULL)
 *     - simulator.html shell:    `devToolsWebContents` → null
 *   This discriminates correctly: if DevTools were wrongly attached to the shell,
 *   the shell's `devToolsWebContents` would be non-null and the assertions below
 *   would fail. We assert this "has a DevTools host attached" fact, not the
 *   non-functional `isDevToolsOpened()`.
 *
 * We can't read the Console panel content (closed shadow DOM), so we assert the
 * reachable, DISCRIMINATING structural facts in the MAIN process via
 * `electronApp.evaluate(({ webContents }) => …)`:
 *   (1) some pageFrame.html guest has a DevTools host attached
 *       (`devToolsWebContents != null`),
 *   (2) the simulator.html shell has NO DevTools host attached,
 *   (3) after a `wx.navigateTo`, the now-active pageFrame guest has a DevTools
 *       host attached — DevTools follows the active page.
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

let electronApp: ElectronApplication
let mainWindow: PwPage
let autoPort = 0

// One-shot JSON-RPC call to the miniprogram-automator WebSocket server. Drives
// the SAME automation handlers the SDK uses; under native-host App.callWxMethod
// routes through serviceWc.executeJavaScript('wx.*'). Mirrors the helper in
// native-host-render.spec.ts.
function wsCall<T = Record<string, unknown>>(
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 12000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${autoPort}`)
    const timer = setTimeout(() => { ws.close(); reject(new Error(`wsCall ${method} timed out`)) }, timeoutMs)
    ws.on('open', () => ws.send(JSON.stringify({ id: 'nhdt1', method, params })))
    ws.on('message', (raw) => {
      let msg: { id?: string; result?: unknown; error?: { message?: string } }
      try { msg = JSON.parse(String(raw)) } catch { return }
      if (msg.id !== 'nhdt1') return
      clearTimeout(timer)
      ws.close()
      if (msg.error) reject(new Error(msg.error.message || 'rpc error'))
      else resolve(msg.result as T)
    })
    ws.on('error', (err) => { clearTimeout(timer); reject(err) })
  })
}

/** Decode a render-host guest's page path out of its `…?pagePath=pages%2F…` URL. */
function guestPagePath(url: string): string {
  const m = url.match(/[?&]pagePath=([^&]+)/)
  if (!m) return ''
  try { return decodeURIComponent(m[1]) } catch { return m[1] }
}

// Structural snapshot of DevTools-HOST-ATTACH state across the relevant
// webContents, taken in the MAIN process. The reliable signal is
// `wc.devToolsWebContents != null` (a DevTools host is attached to that wc) —
// see the file header for why `isDevToolsOpened()` is unusable here. Robust to
// multiple pageFrame guests: reports each guest's page path + whether it has a
// DevTools host, plus the shell's state.
interface DevToolsSnapshot {
  shellFound: boolean
  shellHasDevToolsHost: boolean
  pageFrameCount: number
  pageFrameWithDevToolsHostCount: number
  // page path of each guest that has a DevTools host attached
  guestsWithDevToolsHost: string[]
  pageFramePaths: string[]
}

async function devToolsSnapshot(app: ElectronApplication): Promise<DevToolsSnapshot> {
  const raw = await app.evaluate(({ webContents }) => {
    const all = webContents.getAllWebContents().filter((wc) => !wc.isDestroyed())
    const hasHost = (wc: unknown): boolean =>
      (wc as { devToolsWebContents?: unknown }).devToolsWebContents != null
    const shell = all.find((wc) => wc.getURL().includes('simulator.html'))
    const guests = all.filter((wc) => wc.getURL().includes('pageFrame.html'))
    return {
      shellFound: !!shell,
      shellHasDevToolsHost: shell ? hasHost(shell) : false,
      guests: guests.map((wc) => ({ url: wc.getURL(), hasHost: hasHost(wc) })),
    }
  })
  return {
    shellFound: raw.shellFound,
    shellHasDevToolsHost: raw.shellHasDevToolsHost,
    pageFrameCount: raw.guests.length,
    pageFrameWithDevToolsHostCount: raw.guests.filter((g) => g.hasHost).length,
    guestsWithDevToolsHost: raw.guests.filter((g) => g.hasHost).map((g) => guestPagePath(g.url)),
    pageFramePaths: raw.guests.map((g) => guestPagePath(g.url)),
  }
}

/** Current active mini-app page path (e.g. `pages/detail/detail`) via automation. */
async function activePagePath(): Promise<string> {
  const r = await wsCall<{ path?: string }>('App.getCurrentPage').catch(() => ({} as { path?: string }))
  return r.path ?? ''
}

async function waitForPageFrameGuest(app: ElectronApplication, timeout = 30000): Promise<void> {
  await pollUntil(
    () => app.evaluate(({ webContents }) =>
      webContents.getAllWebContents().some((wc) =>
        !wc.isDestroyed() && wc.getURL().includes('pageFrame.html'),
      ),
    ),
    (present) => present === true,
    timeout,
    300,
  )
}

test.describe('native-host DevTools Console attaches to the active page', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(180_000)

  test.beforeAll(async () => {
    const appPath = path.resolve(__dirname, 'electron-entry.js')
    const userDataDir = path.resolve(
      process.env.DIMINA_DEVTOOLS_DATA_DIR
        ?? path.resolve(__dirname, '..', 'node_modules', '.cache', 'devtools-e2e'),
      'userdata',
      `nh-devtools-console-${process.pid}`,
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

    // DeviceShell mounts only after SimulatorMiniApp.spawn() resolves; wait for it
    // and for at least one render-host guest (pageFrame.html) to exist.
    await pollUntil(
      () => evalInSimulator<boolean>(
        electronApp,
        `(() => !!document.querySelector('.device-shell-root'))()`,
      ).catch(() => false),
      (ok) => ok === true,
      25000,
      300,
    )
    await waitForPageFrameGuest(electronApp)
  })

  test.afterAll(async () => {
    await closeProject(mainWindow).catch(() => {})
    await electronApp?.close().catch(() => {})
  })

  test('a DevTools host is attached to the active render-host guest (pageFrame.html), not the DeviceShell shell', async () => {
    // The DevTools host may attach slightly after the guest paints; poll for the
    // contract (some guest has a DevTools host, shell exists).
    const snap = await pollUntil(
      () => devToolsSnapshot(electronApp),
      (s) => s.shellFound && s.pageFrameCount >= 1 && s.pageFrameWithDevToolsHostCount >= 1,
      30000,
      500,
    )

    // Preconditions: both the shell and at least one page guest exist.
    expect(snap.shellFound, 'the DeviceShell shell (simulator.html) should exist').toBe(true)
    expect(snap.pageFrameCount, 'at least one render-host guest (pageFrame.html) should exist').toBeGreaterThanOrEqual(1)

    // (1) The active mini-app PAGE guest has a DevTools host attached — the
    //     Console inspects the visible page, not the shell.
    expect(
      snap.pageFrameWithDevToolsHostCount,
      `at least one render-host guest (pageFrame.html) should have a DevTools host attached; guest paths=${JSON.stringify(snap.pageFramePaths)}`,
    ).toBeGreaterThanOrEqual(1)

    // (2) The DeviceShell shell document must NOT have a DevTools host attached —
    //     it is the host scaffold, not the inspectable page. (If the build wrongly
    //     attached here, `shell.devToolsWebContents` would be non-null and this
    //     assertion would fail — the signal is discriminating, not vacuous.)
    expect(
      snap.shellHasDevToolsHost,
      'the DeviceShell shell (simulator.html) should NOT have a DevTools host attached',
    ).toBe(false)
  })

  test('after navigateTo, a DevTools host follows the now-active render-host page', async () => {
    // Record the pageFrame guest paths before navigating.
    const before = await devToolsSnapshot(electronApp)

    // Drive a real wx.navigateTo to a valid NON-tab page over the automation WS.
    // `pages/detail/detail` is in app.json `pages` but absent from `tabBar.list`.
    await wsCall('App.callWxMethod', { method: 'navigateTo', args: [{ url: '/pages/detail/detail' }] })

    // Confirm the active page actually switched to detail (the contract is about
    // the ACTIVE page; without this the assertion below could be satisfied by a
    // stale host on a backgrounded guest).
    const active = await pollUntil(
      () => activePagePath(),
      (p) => p.includes('pages/detail/detail'),
      20000,
      500,
    )
    expect(active, 'navigateTo should make pages/detail/detail the active page').toContain('pages/detail/detail')

    // The detail page is now the visible page. Its render-host guest should have a
    // DevTools host attached (DevTools follows the active page), and the shell
    // still must not. Poll: the new guest's host may attach shortly after nav.
    const after = await pollUntil(
      () => devToolsSnapshot(electronApp),
      (s) => s.shellFound && s.guestsWithDevToolsHost.some((p) => p.includes('pages/detail/detail')),
      30000,
      500,
    )

    // A navigation should have produced at least as many page guests as before
    // (the detail guest joins the stack).
    expect(
      after.pageFrameCount,
      'a render-host guest should exist for the newly navigated page',
    ).toBeGreaterThanOrEqual(Math.max(1, before.pageFrameCount))

    // (3) The ACTIVE render-host page guest (the detail page) has a DevTools host
    //     attached after navigation — DevTools followed the active page. This is
    //     tied to the active page path, so a stale host left on the backgrounded
    //     home guest does NOT satisfy it.
    expect(
      after.guestsWithDevToolsHost,
      `after navigateTo, the active render-host guest (pages/detail/detail) should have a DevTools host attached; guests-with-host=${JSON.stringify(after.guestsWithDevToolsHost)}, all-guests=${JSON.stringify(after.pageFramePaths)}`,
    ).toEqual(expect.arrayContaining([expect.stringContaining('pages/detail/detail')]))

    // The shell must still not be the inspected target.
    expect(
      after.shellHasDevToolsHost,
      'after navigateTo, the DeviceShell shell (simulator.html) should still NOT have a DevTools host attached',
    ).toBe(false)
  })
})
