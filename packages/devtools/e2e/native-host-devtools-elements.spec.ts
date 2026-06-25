/**
 * E2E: the right-panel Chrome DevTools Elements panel reflects the ACTIVE RENDER
 * GUEST's live DOM tree (pageFrame.html), NOT the service-host document
 * (service.html / "Dimina Service Host").
 *
 * In native-host mode (DIMINA_NATIVE_HOST=1) there are two WebContents layers:
 *   - Service Host (logic layer): URL contains `service.html`, title is "Dimina Service Host".
 *   - Render guest (view layer): URL contains `pageFrame.html`.
 *
 * The right-panel DevTools front-end (devtools://) natively inspects the service
 * host, but the `elements-forward` feature intercepts DOM./CSS./Overlay. commands
 * from the front-end and re-routes them to the active render guest so Elements
 * reflects the real page DOM.
 *
 * The two invariants guarded here:
 *   1. The elements-forward hook is installed in the front-end realm:
 *      `globalThis.__diminaElementsHookInstalled === true` and
 *      `InspectorFrontendHost.__diminaElementsWrapped === true`.
 *   2. A `DOM.getDocument` call dispatched via the wrapped
 *      `InspectorFrontendHost.sendMessageToBackend` returns a root document whose
 *      `documentURL` points to a `pageFrame.html` URL, never to `service.html` /
 *      "Dimina Service Host". This is the definitive signal that Elements is wired
 *      to the render guest, not the service host.
 *
 * Regression target: when elements-forward degrades (hook absent, wrong routing,
 * no active guest), Elements falls back to the service-host DOM
 * (`<title>Dimina Service Host</title>`). The DOM.getDocument assertion catches
 * that regression deterministically without screenshots.
 */
import { test, expect, _electron, type ElectronApplication, type Page as PwPage } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import {
  openProjectInUI,
  waitForSimulatorWebview,
  closeProject,
  ipcInvoke,
  pollUntil,
  evalInWebContentsByUrl,
} from './helpers'
import { AutomationChannel, SimulatorWxmlChannel } from '../src/shared/ipc-channels'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = path.resolve(__dirname, 'fixtures', 'tabbar-app')

interface AppHandle { app: ElectronApplication; win: PwPage }

interface WxmlNode { tagName?: string; children?: WxmlNode[] }

async function bootApp(): Promise<AppHandle> {
  const appPath = path.resolve(__dirname, 'electron-entry.js')
  const userDataDir = path.resolve(
    process.env.DIMINA_DEVTOOLS_DATA_DIR
      ?? path.resolve(__dirname, '..', 'node_modules', '.cache', 'devtools-e2e'),
    'userdata',
    `nh-devtools-elements-${process.pid}`,
  )
  fs.mkdirSync(userDataDir, { recursive: true })

  const app = await _electron.launch({
    args: [appPath, 'auto', '--auto-port', '0', `--user-data-dir=${userDataDir}`],
    env: { ...process.env, NODE_ENV: 'test', DIMINA_NATIVE_HOST: '1', DIMINA_E2E_USER_DATA_DIR: userDataDir },
  })

  const win = await app.firstWindow()
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

  await pollUntil(
    () => ipcInvoke<number | null>(win, AutomationChannel.GetPort),
    (val) => typeof val === 'number' && val > 0,
    10000,
    100,
  )

  await openProjectInUI(win, FIXTURE_DIR, { waitMs: 20000 })
  await waitForSimulatorWebview(app)

  // Wait for at least one render guest (pageFrame.html) to exist — the
  // elements-forward hook requires an active render guest to route into.
  await pollUntil(
    () => app.evaluate(({ webContents }) =>
      webContents.getAllWebContents().some(
        (wc) => !wc.isDestroyed() && wc.getURL().includes('pageFrame.html'),
      ),
    ),
    (present) => present === true,
    25000,
    300,
  )

  // Wait for the WXML tree to mount — this is the readiness signal the WXML panel
  // uses and indicates the render guest is fully set up.
  await pollUntil(
    () => ipcInvoke<WxmlNode | null>(win, SimulatorWxmlChannel.GetSnapshot).catch(() => null),
    (t) => !!t && typeof (t as WxmlNode).tagName === 'string',
    30000,
    400,
  )

  return { app, win }
}

async function shutdownApp(handle: AppHandle | undefined): Promise<void> {
  if (!handle) return
  await closeProject(handle.win).catch(() => {})
  await handle.app.close().catch(() => {})
}

/**
 * Execute JavaScript in the DevTools front-end realm (devtools:// page).
 * Returns null on any error (front-end not yet ready, wc gone, etc.).
 */
function evalInDevtools<T>(app: ElectronApplication, expression: string): Promise<T | null> {
  return evalInWebContentsByUrl<T>(app, 'devtools://', expression).catch(() => null)
}

/**
 * Send a DOM.getDocument command via the WRAPPED InspectorFrontendHost
 * (the same path the Elements panel uses) and capture the first response with a
 * matching id via window.DevToolsAPI.dispatchMessage interception.
 *
 * Returns the parsed response object, or null on timeout / error.
 *
 * The capture arms a one-shot `dispatchMessage` interceptor BEFORE sending the
 * command, so the response never races. The interceptor is removed after the
 * first matching reply (or on timeout).
 *
 * Timeout is expressed in milliseconds inside the front-end realm via a
 * Promise.race so the call always settles.
 */
async function getDocumentViaFrontend(
  app: ElectronApplication,
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
          if (!IFH || typeof IFH.sendMessageToBackend !== 'function') {
            return resolve(null);
          }
          if (!DTAPI || typeof DTAPI.dispatchMessage !== 'function') {
            return resolve(null);
          }

          var cmdId = Date.now();
          var settled = false;
          var timer = setTimeout(function() {
            if (settled) return;
            settled = true;
            window.DevToolsAPI.dispatchMessage = origDispatch;
            resolve(null);
          }, ${timeoutMs});

          var origDispatch = DTAPI.dispatchMessage.bind(DTAPI);

          // Intercept dispatchMessage to capture the response with our cmdId.
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

          // Send DOM.getDocument via the (possibly wrapped) sendMessageToBackend.
          IFH.sendMessageToBackend(JSON.stringify({
            id: cmdId,
            method: 'DOM.getDocument',
            params: { depth: 2 }
          }));
        } catch(e) {
          resolve(null);
        }
      });
    })()`,
  ).catch(() => null)
}

test.describe('native-host DevTools Elements panel reflects the render guest DOM', () => {
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

  test('elements-forward hook sentinels are installed in the DevTools front-end realm', async () => {
    const { app } = handle!

    // The hook is installed by a polling interval (up to ~10s after dom-ready).
    // Poll until both sentinels appear so we don't race the install timer.
    const hookInstalled = await pollUntil(
      () => evalInDevtools<boolean>(
        app,
        '!!(globalThis.__diminaElementsHookInstalled === true && ' +
        'globalThis.InspectorFrontendHost && ' +
        'globalThis.InspectorFrontendHost.__diminaElementsWrapped === true)',
      ),
      (ok) => ok === true,
      30000,
      300,
    )

    expect(
      hookInstalled,
      'DevTools front-end (devtools://) must have __diminaElementsHookInstalled=true ' +
      'and InspectorFrontendHost.__diminaElementsWrapped=true — the elements-forward hook is not installed',
    ).toBe(true)
  })

  test('DOM.getDocument via the front-end hook returns the render guest document (pageFrame.html), not the service host', async () => {
    const { app } = handle!

    // Wait until the hook is installed before probing (may have already settled
    // from the previous test, but this describe is serial so the guard is cheap).
    await pollUntil(
      () => evalInDevtools<boolean>(
        app,
        '!!(globalThis.__diminaElementsHookInstalled)',
      ),
      (ok) => ok === true,
      15000,
      300,
    )

    // Retry the getDocument call: the drain interval is 150ms and the render guest
    // may still be priming (DOM.enable in flight). A few retries handle that window.
    let response: Record<string, unknown> | null = null
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      response = await getDocumentViaFrontend(app, 4000)
      if (response && response.result) break
      await new Promise((r) => setTimeout(r, 500))
    }

    expect(
      response,
      'DOM.getDocument sent via InspectorFrontendHost.sendMessageToBackend must receive a response within 30s',
    ).toBeTruthy()

    const result = (response as { result?: { root?: { documentURL?: string; baseURL?: string } } })?.result
    expect(
      result,
      `DOM.getDocument response should have a "result" field; got: ${JSON.stringify(response)}`,
    ).toBeTruthy()

    const root = result?.root
    expect(
      root,
      `DOM.getDocument result should contain a "root" node; got result=${JSON.stringify(result)}`,
    ).toBeTruthy()

    // The discriminating assertion: the root document URL must point to the render
    // guest (pageFrame.html). When elements-forward is absent or broken, this URL
    // resolves to the service host's own document (containing "service.html" or
    // having title "Dimina Service Host").
    const docUrl: string = String(root?.documentURL ?? root?.baseURL ?? '')

    expect(
      docUrl,
      `DOM.getDocument root.documentURL should point to the render guest (pageFrame.html) ` +
      `but got: "${docUrl}". This means Elements is inspecting the service host instead of the render guest.`,
    ).toContain('pageFrame.html')

    expect(
      docUrl,
      `DOM.getDocument root.documentURL must not point to the service host (service.html); got: "${docUrl}"`,
    ).not.toContain('service.html')
  })
})
