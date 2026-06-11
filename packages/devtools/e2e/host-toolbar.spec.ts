import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test'
import path from 'path'
import { fileURLToPath } from 'url'
import { DEMO_APP_DIR, openProjectInUI, closeProject, pollUntil } from './helpers'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.resolve(__dirname, 'fixtures', 'host-toolbar')

/**
 * Wave 3 R1 — host toolbar framework runtime is SESSION-RESIDENT (real app).
 *
 * THE INCIDENT THIS SPEC EXISTS FOR: the height advertiser used to ride the
 * toolbar WCV's `webPreferences.preload`; a host calling
 * `hostToolbar.setPreloadPath(<its own preload>)` replaced it wholesale and
 * the toolbar strip silently collapsed to height 0. Under R1 the advertiser
 * lives in a session-registered preload (guarded by the
 * `--dimina-host-toolbar` additionalArguments marker + isMainFrame), so a
 * host preload and the framework runtime must coexist.
 *
 * Flow: boot `host-toolbar-entry.js` (stock `launch()` exposing the instance
 * on globalThis), open the demo project (so the renderer's
 * `[data-area="host-toolbar"]` placeholder + height listener are mounted),
 * then drive `instance.context.views.hostToolbar` from the MAIN process via
 * `electronApp.evaluate`. The observable for "height advertising works" is
 * the main-window placeholder height — it only becomes non-zero if the whole
 * loop ran: toolbar renderer advertiser → gated ipcMain channel → ViewManager
 * → notify → renderer placeholder.
 *
 * Electron e2e; runs on local macOS without extra setup (NODE_ENV=test,
 * off-screen windows).
 */
test.describe('Host toolbar: session-resident height advertiser (R1)', () => {
  test.setTimeout(120_000)
  test.describe.configure({ mode: 'serial' })

  let electronApp: ElectronApplication
  let mainWindow: Page

  test.beforeAll(async () => {
    const entryPath = path.resolve(__dirname, 'host-toolbar-entry.js')
    electronApp = await _electron.launch({
      args: [entryPath],
      env: {
        ...process.env,
        NODE_ENV: 'test',
      },
    })
    mainWindow = await electronApp.firstWindow()
    await mainWindow.waitForLoadState('domcontentloaded')

    // The host-toolbar placeholder (and its height listener) only mounts once
    // a project is open — load toolbar content only after this so the
    // advertise → placeholder loop is deterministic.
    await openProjectInUI(mainWindow, DEMO_APP_DIR, { waitMs: 20_000 })
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

  /** Measured height of the main-window toolbar placeholder (CSS px, rounded). */
  const placeholderHeight = () => mainWindow.evaluate(() => {
    const el = document.querySelector('[data-area="host-toolbar"]')
    return el ? Math.round(el.getBoundingClientRect().height) : -1
  })

  test('default path (no host preload): advertiser drives the placeholder to the content height', async () => {
    // REGRESSION GUARD for the migration itself: the advertiser moves from
    // webPreferences.preload to the session layer — the "host never calls
    // setPreloadPath" path must behave exactly as before (64px content →
    // 64px placeholder). If the session registration / marker / guard chain
    // is mis-wired, the placeholder stays 0 here.
    await electronApp.evaluate((_electronMods, file) => {
      const g = globalThis as unknown as {
        __e2eHostToolbarInstance: {
          context: { views: { hostToolbar: { loadFile(p: string): Promise<void> } } }
        }
      }
      return g.__e2eHostToolbarInstance.context.views.hostToolbar.loadFile(file)
    }, path.join(FIXTURES, 'toolbar-64.html'))

    const height = await pollUntil(placeholderHeight, (v) => v === 64, 30_000, 300)
    expect(height).toBe(64)
  })

  test('host setPreloadPath(custom): height advertising STILL works (the R1 incident, fixed)', async () => {
    // Rebuild the toolbar WCV with a HOST-owned preload: tear the current
    // webContents down (the documented rebuild path), point setPreloadPath at
    // a preload that does only an unrelated thing (exposes a marker global,
    // installs NO advertiser), and load 88px-tall content.
    await electronApp.evaluate((_electronMods) => {
      const g = globalThis as unknown as {
        __e2eHostToolbarInstance: {
          context: { views: { hostToolbar: { webContents: { isDestroyed(): boolean; close(): void } | null } } }
        }
      }
      const wc = g.__e2eHostToolbarInstance.context.views.hostToolbar.webContents
      if (wc && !wc.isDestroyed()) wc.close()
    })
    // Wait until the old webContents is fully gone (the control surface
    // reports null) so the next loadFile lazily rebuilds the view.
    await pollUntil(
      () => electronApp.evaluate((_electronMods) => {
        const g = globalThis as unknown as {
          __e2eHostToolbarInstance: { context: { views: { hostToolbar: { webContents: unknown } } } }
        }
        return g.__e2eHostToolbarInstance.context.views.hostToolbar.webContents === null
      }),
      (gone) => gone === true,
      10_000,
      200,
    )

    await electronApp.evaluate((_electronMods, args) => {
      const g = globalThis as unknown as {
        __e2eHostToolbarInstance: {
          context: {
            views: {
              hostToolbar: {
                setPreloadPath(p: string | null): void
                loadFile(p: string): Promise<void>
              }
            }
          }
        }
      }
      const toolbar = g.__e2eHostToolbarInstance.context.views.hostToolbar
      toolbar.setPreloadPath(args.preload)
      return toolbar.loadFile(args.file)
    }, {
      preload: path.join(FIXTURES, 'host-preload.cjs'),
      file: path.join(FIXTURES, 'toolbar-88.html'),
    })

    // ANTI-CHEAT: the host preload must have REALLY run in the rebuilt
    // toolbar webContents (its marker global is in the page's main world).
    // Without this, an implementation that silently ignores setPreloadPath
    // would pass the height assertion below while breaking every real host.
    const mark = await pollUntil(
      () => electronApp.evaluate(async (_electronMods) => {
        const g = globalThis as unknown as {
          __e2eHostToolbarInstance: {
            context: {
              views: {
                hostToolbar: {
                  webContents: { isDestroyed(): boolean; executeJavaScript(code: string): Promise<unknown> } | null
                }
              }
            }
          }
        }
        const wc = g.__e2eHostToolbarInstance.context.views.hostToolbar.webContents
        if (!wc || wc.isDestroyed()) return null
        return wc.executeJavaScript('window.__e2eHostPreloadMark ?? null')
      }),
      (v) => v === 'ran',
      15_000,
      300,
    )
    expect(mark, 'the host-supplied preload must actually run in the toolbar WCV').toBe('ran')

    // THE R1 ASSERTION: despite the host owning webPreferences.preload, the
    // session-resident advertiser still measures the new 88px content and the
    // placeholder follows. The 64 → 88 change proves a FRESH advertise (not a
    // stale value left over from the default-path test). Under the legacy
    // design this poll times out with the placeholder stuck at 64.
    const height = await pollUntil(placeholderHeight, (v) => v === 88, 30_000, 300)
    expect(height).toBe(88)
  })

  test('no leak: the main window main world carries no toolbar-runtime / host-preload globals', async () => {
    // E2E expression of codex condition 2: the session preload executes in
    // EVERY defaultSession renderer (including this main window — spike item
    // 4), but the marker+isMainFrame guard must make it return before
    // touching the page: no advertiser globals, and — critically — the
    // HOST's preload must never be session-registered (an implementation
    // that "fixes" setPreloadPath by registering the host preload on the
    // session would leak __e2eHostPreloadMark into every window).
    const leaks = await mainWindow.evaluate(() =>
      Object.getOwnPropertyNames(window).filter((name) =>
        // `window.toolbar` (exact name) is excluded: it is the Web-platform
        // BarProp BUILTIN, an own property of EVERY Chromium window — verified
        // on a bare about:blank BrowserWindow in this Electron build — so
        // matching it made this assertion unsatisfiable by any implementation.
        // Every other /toolbar/i name (e.g. __diminaHostToolbar*) still trips.
        (/toolbar/i.test(name) && name !== 'toolbar')
        || name.startsWith('__dimina')
        || name === '__e2eHostPreloadMark',
      ),
    )
    expect(leaks).toEqual([])
  })
})
