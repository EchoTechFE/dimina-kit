import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { DEMO_APP_DIR, openProjectInUI, closeProject, pollUntil, evalInSimulator } from './helpers'

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

  test('registerSimulatorApi: wx.e2eEcho proxies to the host handler', async () => {
    // The simulator preload exposes `window.__diminaCustomApis` — the same
    // bridge the dimina runtime uses to back `wx.<customApi>()`. Invoking it
    // directly exercises the full host-extension path without depending on the
    // demo mini-app calling the API itself:
    //   webview → bridge → renderer proxy → SimulatorCustomApiChannel.Invoke
    //   → ctx.simulatorApis → host's `e2eEcho` handler.
    // The bridge `invoke` promise only settles once the renderer proxy posts
    // a response back; if the proxy hasn't attached yet it never resolves, so
    // each attempt races the invoke against an in-page timeout — that turns a
    // stuck attempt into a retryable `__pending` instead of hanging the whole
    // `executeJavaScript` call (and the test).
    const result = await pollUntil(
      () => evalInSimulator<unknown>(
        electronApp,
        `(() => {
          const bridge = window.__diminaCustomApis
          if (!bridge || typeof bridge.invoke !== 'function') return Promise.resolve({ __noBridge: true })
          const invoke = bridge.invoke('e2eEcho', { ping: 'e2e' })
            .then((r) => ({ ok: true, value: r }))
            .catch((err) => ({ ok: false, error: String(err) }))
          const timeout = new Promise((resolve) => setTimeout(() => resolve({ __pending: true }), 3000))
          return Promise.race([invoke, timeout])
        })()`,
      ),
      (r) => {
        const v = r as { ok?: boolean }
        // Retry while the bridge proxy is still wiring up (webview attach is
        // bounded but async after compileStatus flips to 'ready').
        return v?.ok === true
      },
      30_000,
      500,
    )

    expect(result).toEqual({ ok: true, value: { echoed: { ping: 'e2e' } } })
  })
})
