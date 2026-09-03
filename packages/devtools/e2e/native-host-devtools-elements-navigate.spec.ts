/**
 * E2E: after `wx.navigateTo` opens a new page, the right-panel Chrome DevTools
 * Elements panel must re-target the NEWLY OPENED page's render guest, not
 * stay pinned to the page that was active at boot.
 *
 * Why this needs a real navigation (bridge-router.ts): PAGE_OPEN creates the
 * PageSession with `renderWc: null`. DeviceShell reports ACTIVE_PAGE for the
 * new bridgeId immediately, but the new guest's webContents only binds later —
 * the first time it sends RENDER_INVOKE/RENDER_PUBLISH. elements-forward's
 * `onRenderEvent` only primes a guest (DOM/CSS/Overlay.enable + a
 * `DOM.documentUpdated` push) on `activePage`, so the bridge must emit
 * `activePage` again once that bind completes; otherwise the panel silently
 * keeps serving the PREVIOUS guest's DOM.
 *
 * Fixture: e2e/fixtures/tabbar-app — `pages/home/home` (entry, `.page-home`)
 * and `pages/detail/detail` (`.page-detail`), reachable via
 * `wx.navigateTo({ url: '/pages/detail/detail' })`.
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
  evalInWebContentsByUrl,
  RENDER_GUEST_URL_MARKER,
  findMainWindow,
} from './helpers'
import { AutomationChannel, SimulatorWxmlChannel } from '../src/shared/ipc-channels'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = path.resolve(__dirname, 'fixtures', 'tabbar-app')

const ENTRY_ROUTE = 'pages/home/home'
const TARGET_ROUTE = 'pages/detail/detail'

interface AppHandle { app: ElectronApplication; win: PwPage; autoPort: number }
interface WxmlNode { tagName?: string; children?: WxmlNode[] }

async function bootApp(): Promise<AppHandle> {
  const appPath = path.resolve(__dirname, 'electron-entry.js')
  const userDataDir = path.resolve(
    process.env.DIMINA_DEVTOOLS_DATA_DIR
      ?? path.resolve(__dirname, '..', 'node_modules', '.cache', 'devtools-e2e'),
    'userdata',
    `nh-devtools-elements-nav-${process.pid}`,
  )
  fs.mkdirSync(userDataDir, { recursive: true })

  const app = await _electron.launch({
    args: [appPath, 'auto', '--auto-port', '0', `--user-data-dir=${userDataDir}`],
    env: { ...process.env, NODE_ENV: 'test', DIMINA_NATIVE_HOST: '1', DIMINA_E2E_USER_DATA_DIR: userDataDir },
  })

  const win = await findMainWindow(app)
  await win.waitForLoadState('domcontentloaded')

  await app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    if (w && !w.isVisible()) {
      await new Promise<void>((resolve) => {
        w.once('show', resolve)
        setTimeout(resolve, 5000)
      })
    }
    if (w) {
      w.setPosition(-2000, -2000)
      w.blur()
    }
  })

  const autoPort = await pollUntil(
    () => ipcInvoke<number | null>(win, AutomationChannel.GetPort),
    (val) => typeof val === 'number' && val > 0,
    10000,
    100,
  ) as number

  await openProjectInUI(win, FIXTURE_DIR, { waitMs: 20000 })
  await waitForSimulatorWebview(app)

  await pollUntil(
    () => app.evaluate(({ webContents }, marker) =>
      webContents.getAllWebContents().some(
        (wc) => !wc.isDestroyed() && wc.getURL().includes(marker),
      ),
    RENDER_GUEST_URL_MARKER),
    (present) => present === true,
    25000,
    300,
  )

  await pollUntil(
    () => ipcInvoke<WxmlNode | null>(win, SimulatorWxmlChannel.GetSnapshot).catch(() => null),
    (t) => !!t && typeof (t as WxmlNode).tagName === 'string',
    30000,
    400,
  )

  return { app, win, autoPort }
}

async function shutdownApp(handle: AppHandle | undefined): Promise<void> {
  if (!handle) return
  await closeProject(handle.win).catch(() => {})
  await handle.app.close().catch(() => {})
}

/** One-shot JSON-RPC call to the miniprogram-automator WebSocket server. */
function wsCall<T = Record<string, unknown>>(
  autoPort: number,
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 12000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${autoPort}`)
    const timer = setTimeout(() => { ws.close(); reject(new Error(`wsCall ${method} timed out`)) }, timeoutMs)
    ws.on('open', () => ws.send(JSON.stringify({ id: 'nav1', method, params })))
    ws.on('message', (raw) => {
      let msg: { id?: string; result?: unknown; error?: { message?: string } }
      try { msg = JSON.parse(String(raw)) } catch { return }
      if (msg.id !== 'nav1') return
      clearTimeout(timer)
      ws.close()
      if (msg.error) reject(new Error(msg.error.message || 'rpc error'))
      else resolve(msg.result as T)
    })
    ws.on('error', (err) => { clearTimeout(timer); reject(err) })
  })
}

function evalInDevtools<T>(app: ElectronApplication, expression: string): Promise<T | null> {
  return evalInWebContentsByUrl<T>(app, 'devtools://', expression).catch(() => null)
}

/**
 * Send an arbitrary CDP command via the (possibly elements-forward-wrapped)
 * `InspectorFrontendHost.sendMessageToBackend` and capture the first reply
 * with a matching id through a one-shot `window.DevToolsAPI.dispatchMessage`
 * interception — the same path `getDocumentViaFrontend` in
 * native-host-devtools-elements.spec.ts uses, generalized to any method so it
 * can also probe `Overlay.highlightRect`. The interceptor restores whatever
 * `dispatchMessage` was current before it ran (chaining, not clobbering, a
 * persistent counting hook a caller may have installed).
 */
async function sendCdpCommand(
  app: ElectronApplication,
  method: string,
  params: Record<string, unknown>,
  timeoutMs = 4000,
): Promise<Record<string, unknown> | null> {
  return evalInWebContentsByUrl<Record<string, unknown> | null>(
    app,
    'devtools://',
    `(function() {
      return new Promise(function(resolve) {
        try {
          var IFH = globalThis.InspectorFrontendHost;
          var DTAPI = window.DevToolsAPI;
          if (!IFH || typeof IFH.sendMessageToBackend !== 'function') return resolve(null);
          if (!DTAPI || typeof DTAPI.dispatchMessage !== 'function') return resolve(null);

          var cmdId = Date.now() + Math.floor(Math.random() * 1000);
          var settled = false;
          var timer = setTimeout(function() {
            if (settled) return;
            settled = true;
            window.DevToolsAPI.dispatchMessage = origDispatch;
            resolve(null);
          }, ${timeoutMs});

          var origDispatch = DTAPI.dispatchMessage.bind(DTAPI);

          DTAPI.dispatchMessage = function(messageStr) {
            try {
              var msg = (typeof messageStr === 'string') ? JSON.parse(messageStr) : messageStr;
              if (msg && msg.id === cmdId && !settled) {
                settled = true;
                clearTimeout(timer);
                window.DevToolsAPI.dispatchMessage = origDispatch;
                origDispatch(messageStr);
                resolve(msg);
                return;
              }
            } catch(_) {}
            origDispatch(messageStr);
          };

          IFH.sendMessageToBackend(JSON.stringify({
            id: cmdId,
            method: ${JSON.stringify(method)},
            params: ${JSON.stringify(params)}
          }));
        } catch(e) {
          resolve(null);
        }
      });
    })()`,
  ).catch(() => null)
}

/** Install (once) a persistent counter of `DOM.documentUpdated` notifications
 *  seen by the front-end, chaining onto whatever `dispatchMessage` is current
 *  so later one-shot interceptors (sendCdpCommand) layer on top of it rather
 *  than replacing it. */
async function installDocUpdatedCounter(app: ElectronApplication): Promise<boolean> {
  const ok = await evalInDevtools<boolean>(
    app,
    `(function() {
      var DTAPI = window.DevToolsAPI;
      if (!DTAPI || typeof DTAPI.dispatchMessage !== 'function') return false;
      if (globalThis.__e2eDocUpdatedHookInstalled) return true;
      globalThis.__e2eDocUpdatedCount = 0;
      var orig = DTAPI.dispatchMessage.bind(DTAPI);
      DTAPI.dispatchMessage = function(messageStr) {
        try {
          var msg = (typeof messageStr === 'string') ? JSON.parse(messageStr) : messageStr;
          if (msg && msg.method === 'DOM.documentUpdated') {
            globalThis.__e2eDocUpdatedCount = (globalThis.__e2eDocUpdatedCount || 0) + 1;
          }
        } catch(_) {}
        return orig(messageStr);
      };
      globalThis.__e2eDocUpdatedHookInstalled = true;
      return true;
    })()`,
  )
  return ok === true
}

async function readDocUpdatedCount(app: ElectronApplication): Promise<number> {
  const n = await evalInDevtools<number>(app, 'globalThis.__e2eDocUpdatedCount || 0')
  return n ?? 0
}

test.describe('native-host DevTools Elements panel re-targets the render guest after navigateTo', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(180_000)

  let handle: AppHandle | undefined

  test.beforeAll(async () => {
    test.setTimeout(180_000)
    handle = await bootApp()
  })

  test.afterAll(async () => {
    await shutdownApp(handle)
  })

  test('navigateTo triggers a DOM.documentUpdated push to the front-end for the newly active page', async () => {
    const { app, autoPort } = handle!

    // Sanity: automation reports the entry page before navigating.
    const before = await pollUntil(
      () => wsCall<{ path?: string }>(autoPort, 'App.getCurrentPage').catch(() => null),
      (r) => !!r && typeof r.path === 'string' && r.path.includes(ENTRY_ROUTE),
      20000,
      500,
    )
    expect(before?.path, 'app should start on the entry route').toContain(ENTRY_ROUTE)

    const hookInstalled = await pollUntil(
      () => installDocUpdatedCounter(app),
      (ok) => ok === true,
      15000,
      300,
    )
    expect(hookInstalled, 'DOM.documentUpdated counting hook must install in the devtools:// realm').toBe(true)

    // Reset: only count pushes that happen AFTER this navigation.
    await evalInDevtools(app, 'globalThis.__e2eDocUpdatedCount = 0; true')

    await wsCall(autoPort, 'App.callWxMethod', { method: 'navigateTo', args: [{ url: '/' + TARGET_ROUTE }] })

    const moved = await pollUntil(
      () => wsCall<{ path?: string }>(autoPort, 'App.getCurrentPage').catch(() => null),
      (r) => !!r && typeof r.path === 'string' && r.path.includes(TARGET_ROUTE),
      15000,
      500,
    )
    expect(moved?.path, `navigateTo should move the active page to ${TARGET_ROUTE}`).toContain(TARGET_ROUTE)

    const count = await pollUntil(
      () => readDocUpdatedCount(app),
      (n) => n >= 1,
      15000,
      300,
    )
    expect(
      count,
      'elements-forward must push a DOM.documentUpdated notification once the newly-navigated page becomes active',
    ).toBeGreaterThanOrEqual(1)
  })

  test('Overlay.highlightRect succeeds against the newly active page (its guest has been Overlay.enable-d)', async () => {
    const { app } = handle!

    let response: Record<string, unknown> | null = null
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      response = await sendCdpCommand(app, 'Overlay.highlightRect', { x: 0, y: 0, width: 1, height: 1 }, 4000)
      if (response) break
      await new Promise((r) => setTimeout(r, 500))
    }

    expect(response, 'Overlay.highlightRect must receive a reply within 15s').toBeTruthy()
    expect(
      (response as { error?: unknown } | null)?.error,
      `Overlay.highlightRect should not error on the active (navigated-to) page's guest; got: ${JSON.stringify(response)}`,
    ).toBeUndefined()
  })

  test('DOM.getDocument reflects the navigated-to page (contains page-detail), as a control for the above', async () => {
    const { app } = handle!

    let response: Record<string, unknown> | null = null
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      response = await sendCdpCommand(app, 'DOM.getDocument', { depth: -1 }, 4000)
      if (response && response.result) break
      await new Promise((r) => setTimeout(r, 500))
    }

    expect(response?.result, 'DOM.getDocument must receive a result within 15s').toBeTruthy()
    // Control assertion only: this may already pass even when the two above
    // fail, since automation's currentPage tracking is independent of
    // elements-forward's own activePage plumbing — it just confirms the
    // navigated-to page really is what's rendering.
    expect(JSON.stringify(response)).toContain('page-detail')
  })
})
