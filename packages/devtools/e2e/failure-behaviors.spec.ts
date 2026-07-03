/**
 * Real-machine regressions for the three "silent failure" contracts this
 * branch introduces:
 *
 *  1. Launch-page fallback: a spawn requesting a `pagePath` absent from the
 *     compiled manifest must NOT white-screen. Main resolves to
 *     `entryPagePath`/`pages[0]`, the simulator renders the resolved page, the
 *     main window shows a dismissible `[data-testid="sim-fallback-banner"]`
 *     (see `simulator-runtime-banners.tsx`), and the authoritative diagnostics
 *     bus (`main/services/diagnostics/index.ts`) mirrors one
 *     `[dimina-kit:page-not-found] Page[...] not found...` line into the
 *     Electron MAIN PROCESS console (not a renderer) — the one sink guaranteed
 *     visible even with no live service-host console to inject into. The same
 *     diagnostic is also injected into the service-host's own console (a
 *     `source:'service'` `console-forward` entry, prefixed `[dimina-kit]`
 *     without the `:code` segment) — asserted as a secondary signal via the
 *     existing `installConsoleCollector`/`readConsoleErrors` webContents probe.
 *
 *  2. Service-host crash: a real `render-process-gone` on the service-host
 *     BrowserWindow's webContents must surface a full-screen
 *     `[data-testid="sim-runtime-error"]` overlay in the main window — not a
 *     silently-stuck UI — via `bridge-router.ts`'s `onServiceCrashed` hook
 *     (registered unconditionally, non-pooled and pooled alike).
 *
 *  3. `navigateTo` to a page absent from the compiled manifest must reject via
 *     its `fail` callback with a descriptive `errMsg`
 *     (`checkNavTarget`/`handleNavActionApi` in bridge-router.ts), not hang or
 *     silently no-op.
 *
 * Uses a DEDICATED Electron instance (own `--user-data-dir`, own demo-app
 * mutation) rather than the shared `fixtures.ts` worker instance — test 1
 * persists a project's `compileConfig.startPage` (restored in `finally`) and
 * test 2 forcefully crashes a real renderer process; isolating both from
 * every other spec's shared worker avoids bleeding either into unrelated
 * tests. Mirrors the same standalone-instance pattern as
 * `dock-real-drag.spec.ts`.
 */
import {
  test,
  expect,
  _electron,
  type ElectronApplication,
  type Page as PwPage,
} from '@playwright/test'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  addProject,
  openProjectInUI,
  closeProject,
  DEMO_APP_DIR,
  ipcInvoke,
  installConsoleCollector,
  readConsoleErrors,
  evalInWebContentsByUrl,
  waitSimulatorReady,
  pollUntil,
} from './helpers'
import { ProjectChannel } from '../src/shared/ipc-channels'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

interface CompileConfigLike {
  startPage: string
  scene: number
  queryParams: { key: string; value: string }[]
}

let electronApp: ElectronApplication
let mainWindow: PwPage

test.beforeAll(async () => {
  const appPath = path.resolve(__dirname, 'electron-entry.js')
  const userDataDir = path.join(
    process.env.DIMINA_DEVTOOLS_DATA_DIR
      ?? path.resolve(__dirname, '..', 'node_modules', '.cache', 'devtools-e2e'),
    'userdata',
    'failure-behaviors',
  )
  electronApp = await _electron.launch({
    args: [appPath, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, NODE_ENV: 'test' },
  })
  mainWindow = await electronApp.firstWindow()
  await mainWindow.waitForLoadState('domcontentloaded')
  await installConsoleCollector(electronApp)
  // Offscreen + blur so this suite never steals focus.
  await electronApp.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) { win.setPosition(-2000, -2000); win.blur() }
  })
})

test.afterAll(async () => {
  await electronApp.close().catch(() => {})
})

test.describe('launch page fallback (bridge-router resolveRootPagePath)', () => {
  test.setTimeout(90_000)

  /**
   * Persist a bogus `compileConfig.startPage` for the demo app, open it
   * (spawning a launch request for that page), and return a `restore()` that
   * puts the project's persisted compile config back exactly as found —
   * required because `DEMO_APP_DIR` is a per-worker copy reused by every
   * other spec in this worker.
   */
  async function openWithGhostStartPage(ghostPage: string): Promise<{ restore(): Promise<void> }> {
    await addProject(mainWindow, DEMO_APP_DIR)
    const original = await ipcInvoke<CompileConfigLike>(mainWindow, ProjectChannel.GetCompileConfig, DEMO_APP_DIR)
    await ipcInvoke(mainWindow, ProjectChannel.SaveCompileConfig, DEMO_APP_DIR, {
      startPage: ghostPage,
      scene: original.scene ?? 1001,
      queryParams: original.queryParams ?? [],
    })
    await openProjectInUI(mainWindow, DEMO_APP_DIR, { waitMs: 20000 })
    return {
      restore: async () => {
        await ipcInvoke(mainWindow, ProjectChannel.SaveCompileConfig, DEMO_APP_DIR, original).catch(() => {})
        await closeProject(mainWindow).catch(() => {})
      },
    }
  }

  test('the diagnostics bus mirrors a page-not-found diagnostic to the main-process console AND the service-host console', async () => {
    const GHOST_PAGE = 'pages/e2e-ghost-diag-page/e2e-ghost-diag-page'

    // Real Node `console.*` calls made in the Electron MAIN process (not a
    // renderer webContents) surface here — this is the one place the exact
    // `[dimina-kit:page-not-found]` format (with the `:code` segment) can be
    // observed; `readConsoleErrors` only sees webContents `console-message`
    // events, which is a DIFFERENT mirror (the service-host injection below).
    const mainProcessLines: string[] = []
    const onMainConsole = (msg: { text(): string }) => { mainProcessLines.push(msg.text()) }
    electronApp.on('console', onMainConsole)

    const session = await openWithGhostStartPage(GHOST_PAGE)
    try {
      // 1) Diagnostics bus mirrors a main-process console.error in the exact
      // `[dimina-kit:page-not-found] Page[...] not found...` format.
      await pollUntil(
        async () => mainProcessLines.some((l) =>
          l.includes('[dimina-kit:page-not-found]')
          && l.includes(`Page[${GHOST_PAGE}]`)
          && l.includes('not found')),
        (found) => found === true,
        10000,
        300,
      )
      expect(
        mainProcessLines.some((l) => l.includes('[dimina-kit:page-not-found]') && l.includes(`Page[${GHOST_PAGE}]`)),
        `expected a main-process console.error mentioning Page[${GHOST_PAGE}]; captured: ${JSON.stringify(mainProcessLines.slice(-10))}`,
      ).toBe(true)

      // 2) Secondary signal: the SAME diagnostic is also injected into the
      // service-host's own console (console-forward's `[dimina-kit]` prefix,
      // no `:code` segment) — visible to the webContents-level collector.
      const guestErrors = await readConsoleErrors(electronApp)
      expect(
        guestErrors.some((e) => e.message.includes('[dimina-kit]') && e.message.includes(`Page[${GHOST_PAGE}]`)),
        `expected the diagnostic also injected into the service-host console; captured: ${JSON.stringify(guestErrors.slice(-10))}`,
      ).toBe(true)
    } finally {
      electronApp.off('console', onMainConsole)
      await session.restore()
    }
  })

  test('a fallback banner names the requested and resolved page once the app is running', async () => {
    const GHOST_PAGE = 'pages/e2e-ghost-banner-page/e2e-ghost-banner-page'
    const session = await openWithGhostStartPage(GHOST_PAGE)
    try {
      // NB: real wiring gap found via this e2e — bridge-router's
      // `markSessionRunning` (bridge-router.ts ~919-924) pushes
      // `{ appId, phase: 'running' }` with NO `pageFallback`, and
      // `useSession`'s `onSessionRuntimeStatus` handler (use-session.ts
      // ~227-231) replaces `runtimeStatus` wholesale rather than merging — so
      // `pageFallback` is dropped the instant the session leaves `'launching'`
      // (which fires within a fraction of a second of the resolved page's
      // first paint). `simulator-panel-fallback-banner.test.tsx` unit-tests
      // the component with `{ phase: 'running', pageFallback: {...} }` in the
      // SAME payload — a combination the real pipeline never actually
      // produces. This assertion pins that documented contract and is
      // expected to fail against current wiring (see spec file header).
      const banner = mainWindow.locator('[data-testid="sim-fallback-banner"]')
      await banner.waitFor({ timeout: 15000 })
      const bannerText = await banner.innerText()
      expect(bannerText, 'banner must name the requested (missing) page').toContain(GHOST_PAGE)
      expect(bannerText, 'banner must name the resolved fallback page').toContain('pages/index/index')
    } finally {
      await session.restore()
    }
  })
})

test.describe('service-host crash surfaces a runtime error overlay', () => {
  test.setTimeout(60_000)

  test.afterEach(async () => {
    await closeProject(mainWindow).catch(() => {})
  })

  test('service-host render-process-gone shows [data-testid="sim-runtime-error"]', async () => {
    await openProjectInUI(mainWindow, DEMO_APP_DIR, { waitMs: 20000 })
    await waitSimulatorReady(electronApp)

    const crashed = await electronApp.evaluate(({ webContents }) => {
      const svc = webContents.getAllWebContents().find((wc) => wc.getURL().includes('service.html'))
      if (!svc || svc.isDestroyed()) return false
      svc.forcefullyCrashRenderer()
      return true
    })
    expect(crashed, 'expected a live service-host webContents (service.html) to crash').toBe(true)

    const overlay = mainWindow.locator('[data-testid="sim-runtime-error"]')
    await overlay.waitFor({ timeout: 15000 })
    const overlayText = await overlay.innerText()
    expect(overlayText, 'overlay must tell the user the app crashed').toContain('崩溃')
  })
})

test.describe('navigateTo a page absent from the compiled manifest', () => {
  test.setTimeout(60_000)

  test.afterEach(async () => {
    await closeProject(mainWindow).catch(() => {})
  })

  test('rejects via its fail callback with a descriptive errMsg', async () => {
    await openProjectInUI(mainWindow, DEMO_APP_DIR, { waitMs: 20000 })
    await waitSimulatorReady(electronApp)

    const ghostTarget = 'pages/e2e-ghost-nav-target/e2e-ghost-nav-target'
    const errMsg = await evalInWebContentsByUrl<string>(
      electronApp,
      'service.html',
      `
        new Promise((resolve) => {
          try {
            wx.navigateTo({
              url: '/${ghostTarget}',
              fail: (e) => resolve((e && e.errMsg) || 'NO_ERRMSG'),
              success: () => resolve('UNEXPECTED_SUCCESS'),
            })
          } catch (e) { resolve('THROW:' + (e && e.message)) }
        })
      `,
    )

    expect(errMsg).toContain('navigateTo:fail')
    expect(errMsg).toContain(ghostTarget)
    expect(errMsg).toContain('is not found')
  })
})
