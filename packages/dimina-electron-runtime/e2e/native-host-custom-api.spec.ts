/**
 * E2E (native-host only): a host-registered custom simulator API must
 * be reachable from the simulator document via the documented bridge —
 * `window.__diminaCustomApis.list()` / `.invoke()`.
 *
 * Native-host is the sole simulator runtime here, where the simulator is a
 * top-level main-process WebContentsView, not a renderer `<webview>` guest.
 * The custom-apis bridge is the ONLY simulator-side surface for host-provided
 * APIs registered via the public `runtime.registerApi()` facade (see
 * `extension-host-entry.js`, which registers `e2eEcho` via
 * `runtime.registerApi('e2eEcho', p => ({ echoed: p }))`).
 *
 * CONTRACT: driving the bridge from the simulator document —
 *   window.__diminaCustomApis.invoke('e2eEcho', { ping: 'x' })
 * must resolve to `{ echoed: { ping: 'x' } }`, and `.list()` must include
 * `'e2eEcho'`.
 *
 * Electron e2e; self-launches native-host on local macOS without extra setup.
 */
import { test, expect, _electron, type ElectronApplication, type Page as PwPage } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import {
  DEMO_APP_DIR,
  openProject,
  waitForSimulatorWebview,
  closeProject,
  evalInSimulator,
  pollUntil,
} from './helpers'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let electronApp: ElectronApplication
let mainWindow: PwPage

/**
 * Drive the documented simulator-side bridge from inside the simulator
 * document. Wraps the (possibly never-settling) bridge promise in a JS-side
 * timeout so a hung `invoke()` surfaces as `{ ok:false }` instead of stalling
 * `electronApp.evaluate` / the whole test process. Returns a serializable
 * discriminated result so Playwright can marshal it across the boundary.
 */
async function bridgeInvoke(
  name: string,
  params: unknown,
  timeoutMs = 8000,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  return evalInSimulator(
    electronApp,
    `(() => {
      const api = window.__diminaCustomApis
      if (!api || typeof api.invoke !== 'function') {
        return Promise.resolve({ ok: false, error: 'window.__diminaCustomApis.invoke unavailable' })
      }
      const timeout = new Promise((resolve) =>
        setTimeout(() => resolve({ ok: false, error: 'bridge invoke timed out (no settle)' }), ${timeoutMs}),
      )
      const call = Promise.resolve(api.invoke(${JSON.stringify(name)}, ${JSON.stringify(params)}))
        .then((value) => ({ ok: true, value }))
        .catch((err) => ({ ok: false, error: String((err && err.message) || err) }))
      return Promise.race([call, timeout])
    })()`,
  )
}

async function bridgeList(
  timeoutMs = 8000,
): Promise<{ ok: true; value: string[] } | { ok: false; error: string }> {
  return evalInSimulator(
    electronApp,
    `(() => {
      const api = window.__diminaCustomApis
      if (!api || typeof api.list !== 'function') {
        return Promise.resolve({ ok: false, error: 'window.__diminaCustomApis.list unavailable' })
      }
      const timeout = new Promise((resolve) =>
        setTimeout(() => resolve({ ok: false, error: 'bridge list timed out (no settle)' }), ${timeoutMs}),
      )
      const call = Promise.resolve(api.list())
        .then((value) => ({ ok: true, value }))
        .catch((err) => ({ ok: false, error: String((err && err.message) || err) }))
      return Promise.race([call, timeout])
    })()`,
  )
}

test.describe('native-host custom simulator API bridge (window.__diminaCustomApis) e2e', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(180_000)

  test.beforeAll(async () => {
    // extension-host-entry.js registers `e2eEcho` via `runtime.registerApi()`
    // and wires the same openProject/closeProject hooks as electron-entry.js.
    const entryPath = path.resolve(__dirname, 'extension-host-entry.js')
    const userDataDir = path.resolve(
      process.env.DIMINA_DEVTOOLS_DATA_DIR
        ?? path.resolve(__dirname, '..', 'node_modules', '.cache', 'electron-runtime-e2e'),
      'userdata',
      `nh-custom-api-${process.pid}`,
    )
    fs.mkdirSync(userDataDir, { recursive: true })

    electronApp = await _electron.launch({
      args: [entryPath, `--user-data-dir=${userDataDir}`],
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DIMINA_E2E_USER_DATA_DIR: userDataDir,
      },
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

    await openProject(electronApp, DEMO_APP_DIR)
    await waitForSimulatorWebview(electronApp)
  })

  test.afterAll(async () => {
    await closeProject(electronApp).catch(() => {})
    await Promise.race([
      electronApp?.close().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 15_000)),
    ])
  })

  test('window.__diminaCustomApis.invoke("e2eEcho") reaches the host handler under native-host', async () => {
    // Native-host readiness gate: DeviceShell mounts only once the native-host
    // pipeline spawns the simulator WebContentsView. `.device-shell-root` is the
    // native-host discriminator (the default dimina-fe path never emits it).
    const shellMounted = await pollUntil(
      () => evalInSimulator<boolean>(
        electronApp,
        `(() => !!document.querySelector('.device-shell-root'))()`,
      ).catch(() => false),
      (ok) => ok === true,
      25_000,
      300,
    )
    expect(shellMounted, 'DeviceShell .device-shell-root should mount under native-host').toBe(true)

    // The bridge surface itself must be installed in the simulator document
    // (it is — `src/preload/windows/simulator.ts` calls
    // `installCustomApisBridge()` unconditionally).
    const surfacePresent = await evalInSimulator<boolean>(
      electronApp,
      `(() => {
        const api = window.__diminaCustomApis
        return !!api && typeof api.invoke === 'function' && typeof api.list === 'function'
      })()`,
    )
    expect(surfacePresent, 'window.__diminaCustomApis bridge surface should be installed').toBe(true)

    // CONTRACT 1 — list() must include the host-registered API.
    const listResult = await bridgeList()
    expect(
      listResult,
      `__diminaCustomApis.list() should resolve and include 'e2eEcho' (got: ${JSON.stringify(listResult)})`,
    ).toEqual({ ok: true, value: expect.arrayContaining(['e2eEcho']) })

    // CONTRACT 2 — invoke() must round-trip to the host handler and resolve
    // with its return value.
    const invokeResult = await bridgeInvoke('e2eEcho', { ping: 'x' })
    expect(
      invokeResult,
      `__diminaCustomApis.invoke('e2eEcho', { ping: 'x' }) should resolve to { echoed: { ping: 'x' } } (got: ${JSON.stringify(invokeResult)})`,
    ).toEqual({ ok: true, value: { echoed: { ping: 'x' } } })
  })
})
