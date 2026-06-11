import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test'
import path from 'path'
import { fileURLToPath } from 'url'
import { DEMO_APP_DIR, openProjectInUI, closeProject, pollUntil, evalInSimulator, ipcInvoke } from './helpers'
import { SimulatorCustomApiChannel } from '../src/shared/ipc-channels'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * End-to-end coverage of the downstream-host extension path: a host that
 * integrates devtools via `createWorkbenchApp({ headerHeight, onSetup })` and
 * injects extensions inside `onSetup(instance)`.
 *
 * `e2e/extension-host-entry.js` is the host entry — it registers a simulator
 * custom API (`e2eEcho`) and still passes the deprecated `headerHeight: 72`
 * (which must be runtime-ignored without crashing launch). This spec drives
 * that real Electron app and asserts the injected extension actually runs
 * end-to-end (not just that the API surface exists — that's already
 * unit-covered).
 *
 * Host toolbar actions (`instance.toolbar.set` / E2E_TOOLBAR_ACTION) are
 * decommissioned and no longer covered — the custom-API mechanism
 * (`registerSimulatorApi`) is the surviving extension surface.
 *
 * Electron e2e; runs on local macOS without extra setup.
 */
test.describe('Extension host (createWorkbenchApp onSetup)', () => {
  test.setTimeout(90_000)
  test.describe.configure({ mode: 'serial' })

  let electronApp: ElectronApplication
  let mainWindow: Page

  test.beforeAll(async () => {
    const entryPath = path.resolve(__dirname, 'extension-host-entry.js')
    electronApp = await _electron.launch({
      args: [entryPath],
      env: {
        ...process.env,
        NODE_ENV: 'test',
      },
    })
    mainWindow = await electronApp.firstWindow()
    await mainWindow.waitForLoadState('domcontentloaded')

    // The toolbar only renders once a project is open.
    await openProjectInUI(mainWindow, DEMO_APP_DIR, { waitMs: 20_000 })
  })

  test.afterAll(async () => {
    // Close the project first: this detaches the CDP debugger that
    // setupSimulatorStorage attached to the simulator <webview>. Leaving it
    // attached makes `electronApp.close()` hang past the hook timeout.
    if (mainWindow && !mainWindow.isClosed()) {
      await closeProject(mainWindow).catch(() => {})
    }
    // Hard cap on close() — never let a stuck Electron exit blow the hook
    // timeout; the OS reaps the orphan process either way.
    await Promise.race([
      electronApp?.close().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 15_000)),
    ])
  })

  test('deprecated headerHeight config is ignored (toolbar header stays 40px)', async () => {
    // `headerHeight` is decommissioned: the host entry still passes 72 (which
    // must not crash launch — proven by this suite booting at all), but
    // project-toolbar.tsx renders its main row at the fixed HEADER_H constant
    // (40px) and no longer fetches a height over IPC. A 72px reading means
    // the legacy config→IPC→renderer plumbing has come back.
    const measure = () => mainWindow.evaluate(() => {
      // The header is the toolbar row holding the "普通编译" compile button.
      const buttons = Array.from(document.querySelectorAll('button'))
      const compileBtn = buttons.find((b) => (b.textContent || '').includes('普通编译'))
      if (!compileBtn) return null
      // Walk up to the flex row that carries the inline height style.
      let el: HTMLElement | null = compileBtn.parentElement
      while (el) {
        if (el.style && el.style.height) return parseInt(el.style.height, 10)
        el = el.parentElement
      }
      return null
    })
    const height = await pollUntil(measure, (h) => h !== null, 10_000, 300)
    expect(height).toBe(40)
    // Settle guard: the legacy behavior painted 40 first and flipped to 72
    // once the IPC resolved — re-measure after a beat to catch that flip.
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    expect(await measure()).toBe(40)
  })

  test('registerSimulatorApi: custom-apis channel proxies e2eEcho to the host handler', async () => {
    // SCOPE: this test covers the custom-apis BRIDGE destination —
    //   <trusted invoker> → SimulatorCustomApiChannel.Invoke → ctx.simulatorApis
    //   → host's `e2eEcho` handler (registered in onSetup via
    //   `instance.registerSimulatorApi`).
    //
    // NATIVE-HOST MIGRATION: under the native-host runtime (now the default —
    // `DIMINA_NATIVE_HOST !== '0'`), the simulator is a top-level
    // WebContentsView, NOT a renderer `<webview>` guest. The OLD assertion drove
    // the bridge from the simulator document via `window.__diminaCustomApis.invoke`,
    // whose `invoke` does `ipcRenderer.sendToHost` → the main-window renderer's
    // `useCustomApiProxy` (`ipc-message` on the `<webview>` tag) → this channel.
    // `sendToHost` only delivers to a `<webview>`'s embedder; a top-level
    // WebContentsView has no embedder and the renderer has no `<webview>` for the
    // proxy to attach to, so that simulator-side leg is structurally unreachable
    // under native-host. The renderer-proxy/`sendToHost` legs are an arch detail
    // of the `<webview>` path; the LOAD-BEARING destination the test asserts —
    // `SimulatorCustomApiChannel.Invoke` routing to `ctx.simulatorApis.invoke`,
    // which is the per-context registry `registerSimulatorApi('e2eEcho', …)`
    // populated — is arch-independent. We drive it directly from the trusted
    // main-window renderer (on the workbench sender white-list), which is exactly
    // where the renderer proxy would have forwarded to.
    //
    // This still does NOT cover the mini-app `wx.e2eEcho(...)` registration layer
    // (that surface lives only inside the hidden service-host Worker and is not a
    // webContents Playwright can drive); it asserts the host-extension API reaches
    // its registered handler with the right params and result.

    // Native-host readiness gate: DeviceShell mounts only after the native-host
    // pipeline spawns. Once `.device-shell-root` is up, the project session
    // (and thus `ctx.simulatorApis`) is fully wired. `.device-shell-root` is the
    // native-host discriminator the dimina-fe path never emits.
    await pollUntil(
      () => evalInSimulator<boolean>(
        electronApp,
        `(() => !!document.querySelector('.device-shell-root'))()`,
      ).catch(() => false),
      (ok) => ok === true,
      25_000,
      300,
    )

    const result = await pollUntil(
      () => ipcInvoke<unknown>(
        mainWindow,
        SimulatorCustomApiChannel.Invoke,
        'e2eEcho',
        { ping: 'e2e' },
      )
        .then((value) => ({ ok: true as const, value }))
        .catch((err: unknown) => ({ ok: false as const, error: String(err) })),
      (r) => (r as { ok?: boolean }).ok === true,
      30_000,
      500,
    )

    expect(result).toEqual({ ok: true, value: { echoed: { ping: 'e2e' } } })
  })
})
