import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
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
 * `e2e/extension-host-entry.js` is the host entry — it registers a custom
 * toolbar action (`E2E_TOOLBAR_ACTION`) and a simulator custom API
 * (`e2eEcho`), and sets `headerHeight: 72`. This spec drives that real
 * Electron app and asserts the injected extensions actually run end-to-end
 * (not just that the API surface exists — that's already unit-covered).
 *
 * Electron e2e; runs on local macOS without extra setup.
 */
test.describe('Extension host (createWorkbenchApp onSetup)', () => {
  test.setTimeout(90_000)
  test.describe.configure({ mode: 'serial' })

  let electronApp: ElectronApplication
  let mainWindow: Page
  let sentinelPath: string

  test.beforeAll(async () => {
    // The host's toolbar handler writes here; the spec polls for it to prove
    // the click reached the host-registered handler.
    sentinelPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'dimina-e2e-ext-')),
      'toolbar-sentinel.txt',
    )

    const entryPath = path.resolve(__dirname, 'extension-host-entry.js')
    electronApp = await _electron.launch({
      args: [entryPath],
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DIMINA_E2E_TOOLBAR_SENTINEL: sentinelPath,
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
    try {
      fs.rmSync(path.dirname(sentinelPath), { recursive: true, force: true })
    } catch {}
  })

  test('custom toolbar action: button renders and click reaches the host handler', async () => {
    // The host registered one action via `instance.toolbar.set([...])`; it
    // renders as a <Button> whose text is the action label.
    const actionButton = mainWindow.getByRole('button', { name: 'E2E_TOOLBAR_ACTION' })
    await expect(actionButton).toBeVisible({ timeout: 15_000 })

    // Sentinel must not exist before the click — otherwise a pre-existing file
    // would make the assertion below pass without the handler ever running.
    expect(fs.existsSync(sentinelPath)).toBe(false)

    await actionButton.click()

    // Poll for the sentinel: its presence + content proves the click travelled
    // renderer → ToolbarChannel.Invoke → context.toolbar handler → host fn.
    const content = await pollUntil(
      () => Promise.resolve(fs.existsSync(sentinelPath) ? fs.readFileSync(sentinelPath, 'utf8') : ''),
      (value) => value.length > 0,
      10_000,
      200,
    )
    expect(content).toBe('e2e-action:invoked')
  })

  test('headerHeight config reaches the renderer (toolbar header is 72px)', async () => {
    // project-toolbar.tsx renders the toolbar header div with
    // `style={{ height: headerHeight }}`, defaulting to HEADER_H (40) until
    // `app:getHeaderHeight` resolves. The host configured 72, so the rendered
    // element must measure 72 — not the 40px default.
    const height = await pollUntil(
      () => mainWindow.evaluate(() => {
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
      }),
      (h) => h === 72,
      10_000,
      300,
    )
    expect(height).toBe(72)
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
