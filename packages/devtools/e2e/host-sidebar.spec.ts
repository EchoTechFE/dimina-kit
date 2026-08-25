import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test'
import path from 'path'
import { fileURLToPath } from 'url'
import { DEMO_APP_DIR, openProjectInUI, closeProject, pollUntil } from './helpers'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.resolve(__dirname, 'fixtures', 'host-sidebar')

/**
 * Host sidebar framework runtime is SESSION-RESIDENT (real app) — the same R1
 * design as host-toolbar.spec.ts's height advertiser, just on the inline
 * (width) axis and scoped to the project-LIST page instead of project-runtime.
 *
 * `[data-area="host-sidebar"]` (project-list-screen.tsx) mounts at app boot,
 * before any project is opened — the OPPOSITE screen-scoping from the toolbar
 * (which only mounts once a project is open). Entering a project unmounts
 * ProjectListScreen, whose placement publisher flushes an empty snapshot on
 * dispose — the same detach mechanism host-toolbar.spec.ts exercises on
 * project CLOSE, here exercised on project OPEN.
 *
 * Electron e2e; runs on local macOS without extra setup (NODE_ENV=test,
 * off-screen windows).
 */
test.describe('Host sidebar: session-resident width advertiser (R1, inline axis)', () => {
  test.setTimeout(120_000)
  test.describe.configure({ mode: 'serial' })

  let electronApp: ElectronApplication
  let mainWindow: Page

  test.beforeAll(async () => {
    const entryPath = path.resolve(__dirname, 'host-sidebar-entry.js')
    electronApp = await _electron.launch({
      args: [entryPath],
      env: {
        ...process.env,
        NODE_ENV: 'test',
      },
    })
    mainWindow = await electronApp.firstWindow()
    await mainWindow.waitForLoadState('domcontentloaded')
    // No openProjectInUI here: unlike the toolbar, the sidebar placeholder is
    // already mounted on the boot screen (project list).
  })

  test.afterAll(async () => {
    await Promise.race([
      electronApp?.close().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 15_000)),
    ])
  })

  /** Measured width of the project-list sidebar placeholder (CSS px, rounded). */
  const placeholderWidth = () => mainWindow.evaluate(() => {
    const el = document.querySelector('[data-area="host-sidebar"]')
    return el ? Math.round(el.getBoundingClientRect().width) : -1
  })

  test('default path (no host preload): advertiser drives the placeholder to the content width', async () => {
    // REGRESSION GUARD mirroring host-toolbar.spec.ts's default-path test on
    // the inline axis: if the session registration / marker / guard chain is
    // mis-wired, the placeholder stays 0 here.
    await electronApp.evaluate((_electronMods, file) => {
      const g = globalThis as unknown as {
        __e2eHostSidebarInstance: {
          context: { views: { hostSidebar: { loadFile(p: string): Promise<void> } } }
        }
      }
      return g.__e2eHostSidebarInstance.context.views.hostSidebar.loadFile(file)
    }, path.join(FIXTURES, 'sidebar-64.html'))

    const width = await pollUntil(placeholderWidth, (v) => v === 64, 30_000, 300)
    expect(width).toBe(64)
  })

  test('host setPreloadPath(custom): width advertising STILL works (the R1 pattern, inline axis)', async () => {
    // Rebuild the sidebar WCV with a HOST-owned preload: tear the current
    // webContents down, point setPreloadPath at a preload that does only an
    // unrelated thing (exposes a marker global, installs NO advertiser), and
    // load 88px-wide content.
    await electronApp.evaluate((_electronMods) => {
      const g = globalThis as unknown as {
        __e2eHostSidebarInstance: {
          context: { views: { hostSidebar: { webContents: { isDestroyed(): boolean; close(): void } | null } } }
        }
      }
      const wc = g.__e2eHostSidebarInstance.context.views.hostSidebar.webContents
      if (wc && !wc.isDestroyed()) wc.close()
    })
    await pollUntil(
      () => electronApp.evaluate((_electronMods) => {
        const g = globalThis as unknown as {
          __e2eHostSidebarInstance: { context: { views: { hostSidebar: { webContents: unknown } } } }
        }
        return g.__e2eHostSidebarInstance.context.views.hostSidebar.webContents === null
      }),
      (gone) => gone === true,
      10_000,
      200,
    )

    await electronApp.evaluate((_electronMods, args) => {
      const g = globalThis as unknown as {
        __e2eHostSidebarInstance: {
          context: {
            views: {
              hostSidebar: {
                setPreloadPath(p: string | null): void
                loadFile(p: string): Promise<void>
              }
            }
          }
        }
      }
      const sidebar = g.__e2eHostSidebarInstance.context.views.hostSidebar
      sidebar.setPreloadPath(args.preload)
      return sidebar.loadFile(args.file)
    }, {
      preload: path.join(FIXTURES, 'host-preload.cjs'),
      file: path.join(FIXTURES, 'sidebar-88.html'),
    })

    // ANTI-CHEAT: the host preload must have REALLY run in the rebuilt
    // sidebar webContents.
    const mark = await pollUntil(
      () => electronApp.evaluate(async (_electronMods) => {
        const g = globalThis as unknown as {
          __e2eHostSidebarInstance: {
            context: {
              views: {
                hostSidebar: {
                  webContents: { isDestroyed(): boolean; executeJavaScript(code: string): Promise<unknown> } | null
                }
              }
            }
          }
        }
        const wc = g.__e2eHostSidebarInstance.context.views.hostSidebar.webContents
        if (!wc || wc.isDestroyed()) return null
        return wc.executeJavaScript('window.__e2eHostPreloadMark ?? null')
      }),
      (v) => v === 'ran',
      15_000,
      300,
    )
    expect(mark, 'the host-supplied preload must actually run in the sidebar WCV').toBe('ran')

    // 64 → 88 proves a FRESH advertise, not a stale placeholder value.
    const width = await pollUntil(placeholderWidth, (v) => v === 88, 30_000, 300)
    expect(width).toBe(88)
  })

  test('no leak: the main window main world carries no sidebar-runtime / host-preload globals', async () => {
    const leaks = await mainWindow.evaluate(() =>
      Object.getOwnPropertyNames(window).filter((name) =>
        /sidebar/i.test(name)
        || name.startsWith('__dimina')
        || name === '__e2eHostPreloadMark',
      ),
    )
    expect(leaks).toEqual([])
  })

  test('entering a project detaches the sidebar WCV; returning to the list re-attaches it', async () => {
    /** Is the sidebar WCV currently among any window's contentView children? */
    const sidebarAttached = () => electronApp.evaluate(({ BrowserWindow }) => {
      const g = globalThis as unknown as {
        __e2eHostSidebarInstance: {
          context: { views: { hostSidebar: { webContents: { id: number; isDestroyed(): boolean } | null } } }
        }
      }
      const wc = g.__e2eHostSidebarInstance.context.views.hostSidebar.webContents
      if (!wc || wc.isDestroyed()) return false
      return BrowserWindow.getAllWindows().some((win) => {
        const children = win.contentView.children as Array<{ webContents?: { id: number } }>
        return children.some((v) => v.webContents?.id === wc.id)
      })
    })

    // Meaningfulness guard: the strip really is attached on the list page
    // (from the 88px reload above) before we navigate away.
    expect(await sidebarAttached()).toBe(true)

    await openProjectInUI(mainWindow, DEMO_APP_DIR, { waitMs: 20_000 })

    const detachedInProject = await pollUntil(
      sidebarAttached,
      (attached) => attached === false,
      15_000,
      300,
    )
    expect(detachedInProject).toBe(false)

    await closeProject(mainWindow)

    const reattachedOnList = await pollUntil(
      sidebarAttached,
      (attached) => attached === true,
      15_000,
      300,
    )
    expect(reattachedOnList).toBe(true)
  })
})
