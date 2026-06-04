/**
 * E2E (native-host only, TDD RED): a host-registered custom simulator API must
 * be reachable from the simulator document via the documented bridge —
 * `window.__diminaCustomApis.list()` / `.invoke()` — under DIMINA_NATIVE_HOST=1.
 *
 * THE BUG THIS PINS: native-host is the sole simulator runtime, where the
 * simulator is a TOP-LEVEL main-process WebContentsView, not a renderer
 * `<webview>` guest. The documented simulator-side bridge
 * (`src/preload/runtime/custom-apis.ts`) implements `invoke()` via
 * `ipcRenderer.sendToHost(SimulatorCustomApiBridgeChannel.Request)`, which only
 * delivers to a `<webview>`'s embedder renderer — where a host-side
 * `useCustomApiProxy` would forward it to `SimulatorCustomApiChannel.Invoke`.
 * A top-level WebContentsView has NO embedder, and there is no main-process
 * listener for that Request, so `invoke()` never reaches the host handler:
 * the call hangs (no settle) and `list()` rejects at its ceiling with
 * "custom-apis bridge list() got no response from the host renderer".
 *
 * CONTRACT (what GREEN means): with `e2eEcho` registered by the host in
 * `onSetup` (`instance.registerSimulatorApi('e2eEcho', p => ({ echoed: p }))`,
 * see `extension-host-entry.js`), driving the bridge from the simulator document
 *   window.__diminaCustomApis.invoke('e2eEcho', { ping: 'x' })
 * must resolve to `{ echoed: { ping: 'x' } }`, and `.list()` must include
 * `'e2eEcho'`. Today both fail (reject/timeout) — this spec is RED until the
 * native-host runtime routes the simulator-side bridge to `ctx.simulatorApis`.
 *
 * WHY THIS IS THE LOAD-BEARING PATH (not the capturepoint `extension-host.spec`
 * uses): the sibling spec asserts the bridge DESTINATION
 * (`SimulatorCustomApiChannel.Invoke → ctx.simulatorApis`) by invoking the
 * channel DIRECTLY from the trusted main-window renderer — it deliberately
 * skips the `sendToHost → host → Response` round-trip because that leg is
 * structurally broken under native-host. THIS spec exercises exactly that
 * broken leg, via `window.__diminaCustomApis`, which is what a real mini-app /
 * host integrator actually calls. So this is the test that captures the bug.
 *
 * Electron e2e; self-launches native-host on local macOS without extra setup.
 */
import { test, expect, _electron, type ElectronApplication, type Page as PwPage } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import {
  DEMO_APP_DIR,
  openProjectInUI,
  waitForSimulatorWebview,
  closeProject,
  evalInSimulator,
  pollUntil,
} from './helpers'

// NOTE: scope DIMINA_NATIVE_HOST to THIS spec's electron launch (below), never
// `process.env` — a module-top mutation poisons the shared --workers=1 runner,
// flipping every other spec into native-host mode (mass cross-spec failures).

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
    // Reuse the downstream-host extension entry — it registers `e2eEcho` via
    // `createWorkbenchApp({ onSetup })` (`instance.registerSimulatorApi`) and,
    // because it reads --auto/--auto-port/--project from process.argv, also
    // brings up the automation pipeline when passed `auto`. We launch it under
    // native-host so the simulator boots as the top-level WebContentsView.
    const entryPath = path.resolve(__dirname, 'extension-host-entry.js')
    const userDataDir = path.resolve(
      process.env.DIMINA_DEVTOOLS_DATA_DIR
        ?? path.resolve(__dirname, '..', 'node_modules', '.cache', 'devtools-e2e'),
      'userdata',
      `nh-custom-api-${process.pid}`,
    )
    fs.mkdirSync(userDataDir, { recursive: true })

    electronApp = await _electron.launch({
      args: [entryPath, 'auto', '--auto-port', '0', `--user-data-dir=${userDataDir}`],
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DIMINA_NATIVE_HOST: '1',
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

    await openProjectInUI(mainWindow, DEMO_APP_DIR, { waitMs: 20_000 })
    await waitForSimulatorWebview(electronApp)
  })

  test.afterAll(async () => {
    if (mainWindow && !mainWindow.isClosed()) {
      await closeProject(mainWindow).catch(() => {})
    }
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
    expect(shellMounted, 'DeviceShell .device-shell-root should mount under DIMINA_NATIVE_HOST=1').toBe(true)

    // The bridge surface itself must be installed in the simulator document
    // (it is — `src/preload/windows/simulator.ts` calls
    // `installCustomApisBridge()` unconditionally). The bug is in the
    // round-trip, not the surface.
    const surfacePresent = await evalInSimulator<boolean>(
      electronApp,
      `(() => {
        const api = window.__diminaCustomApis
        return !!api && typeof api.invoke === 'function' && typeof api.list === 'function'
      })()`,
    )
    expect(surfacePresent, 'window.__diminaCustomApis bridge surface should be installed').toBe(true)

    // CONTRACT 1 — list() must include the host-registered API. Today this
    // rejects at the ceiling with "got no response from the host renderer".
    const listResult = await bridgeList()
    expect(
      listResult,
      `__diminaCustomApis.list() should resolve and include 'e2eEcho' (got: ${JSON.stringify(listResult)})`,
    ).toEqual({ ok: true, value: expect.arrayContaining(['e2eEcho']) })

    // CONTRACT 2 — invoke() must round-trip to the host handler and resolve
    // with its return value. Today this hangs (no embedder → no Response).
    const invokeResult = await bridgeInvoke('e2eEcho', { ping: 'x' })
    expect(
      invokeResult,
      `__diminaCustomApis.invoke('e2eEcho', { ping: 'x' }) should resolve to { echoed: { ping: 'x' } } (got: ${JSON.stringify(invokeResult)})`,
    ).toEqual({ ok: true, value: { echoed: { ping: 'x' } } })
  })
})
