import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test'
import path from 'path'
import { fileURLToPath } from 'url'
import { DEMO_APP_DIR, openProjectInUI, closeProject, pollUntil } from './helpers'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.resolve(__dirname, 'fixtures', 'host-toolbar')

/**
 * Host-toolbar height REPLAY (downstream feedback bug, real app).
 *
 * THE BUG THIS SPEC EXISTS FOR: the dynamic-height chain is push-only with no
 * replay anywhere — the toolbar WCV's size-advertiser deduplicates (a height
 * already reported is never re-sent), main does not retain the notified value,
 * and the main-window renderer's `HostToolbarHeightChanged` listener mounts
 * only with the project view. So a notify that fires while no project view is
 * mounted is PERMANENTLY lost and the toolbar strip stays collapsed at 0:
 *  - close project → reopen reproduces it 100% deterministically (the
 *    placeholder component is rebuilt at 0; the deduped advertiser never
 *    re-reports);
 *  - cold-starting on the project list races the advertise against project
 *    open.
 *
 * The fix contract: main RETAINS the last notified height (new
 * `views.getHostToolbarHeight()` getter) and the renderer PULLS it on mount
 * via the new `view:host-toolbar:get-height` invoke (subscribe-then-pull).
 * Companion unit pins: host-toolbar-height-retention.test.ts,
 * views-host-toolbar-get-height.test.ts,
 * project-runtime-host-toolbar-replay.test.tsx,
 * view-api-get-host-toolbar-height.test.ts.
 *
 * Reuses `host-toolbar-entry.js` (stock `launch()` exposing the instance on
 * globalThis) and the host-toolbar fixtures. Electron e2e; runs on local
 * macOS without extra setup (NODE_ENV=test, off-screen windows).
 *
 * Guards that reopen/cold-start recovers the advertised height instead of
 * leaving the placeholder stuck at 0, via the retention getter.
 */

/** Measured height of the main-window toolbar placeholder (CSS px, rounded). */
const placeholderHeightOf = (mainWindow: Page) => () => mainWindow.evaluate(() => {
  const el = document.querySelector('[data-area="host-toolbar"]')
  return el ? Math.round(el.getBoundingClientRect().height) : -1
})

function launchApp(): Promise<ElectronApplication> {
  const entryPath = path.resolve(__dirname, 'host-toolbar-entry.js')
  return _electron.launch({
    args: [entryPath],
    env: {
      ...process.env,
      NODE_ENV: 'test',
    },
  })
}

async function loadToolbar64(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate((_electronMods, file) => {
    const g = globalThis as unknown as {
      __e2eHostToolbarInstance: {
        context: { views: { hostToolbar: { loadFile(p: string): Promise<void> } } }
      }
    }
    return g.__e2eHostToolbarInstance.context.views.hostToolbar.loadFile(file)
  }, path.join(FIXTURES, 'toolbar-64.html'))
}

test.describe('Host toolbar height replay: close project → reopen (deterministic repro)', () => {
  test.setTimeout(180_000)
  test.describe.configure({ mode: 'serial' })

  let electronApp: ElectronApplication
  let mainWindow: Page

  test.beforeAll(async () => {
    electronApp = await launchApp()
    mainWindow = await electronApp.firstWindow()
    await mainWindow.waitForLoadState('domcontentloaded')
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

  test('the placeholder recovers the advertised 64px after close → reopen', async () => {
    const placeholderHeight = placeholderHeightOf(mainWindow)

    // Precondition (same flow as host-toolbar.spec.ts): with
    // the project open, the advertise → notify → placeholder loop lands 64.
    await loadToolbar64(electronApp)
    const before = await pollUntil(placeholderHeight, (v) => v === 64, 30_000, 300)
    expect(before, 'precondition: live advertise must drive the placeholder to 64').toBe(64)

    // Close the project (the placeholder component unmounts) and reopen it
    // (a FRESH placeholder mounts at 0). The toolbar WCV and its content
    // survive the project session; its advertiser already reported 64 and
    // deduplicates, so nothing will ever push again.
    await closeProject(mainWindow)
    await openProjectInUI(mainWindow, DEMO_APP_DIR, { waitMs: 20_000 })

    // THE REPLAY ASSERTION: the freshly-mounted placeholder must recover the
    // retained 64 by pulling it from main. Today nothing replays — this poll
    // times out with the strip collapsed at 0 (the downstream bug).
    const after = await pollUntil(placeholderHeight, (v) => v === 64, 15_000, 300)
    expect(
      after,
      'after close → reopen the placeholder must replay the retained toolbar height (today it is stuck at 0 — the advertiser never re-reports)',
    ).toBe(64)
  })
})

test.describe('Host toolbar height replay: cold start (advertise before any project open)', () => {
  test.setTimeout(180_000)
  test.describe.configure({ mode: 'serial' })

  let electronApp: ElectronApplication
  let mainWindow: Page

  test.beforeAll(async () => {
    electronApp = await launchApp()
    mainWindow = await electronApp.firstWindow()
    await mainWindow.waitForLoadState('domcontentloaded')
    // Deliberately NO project open here — the advertise must land while the
    // main window still shows the project list (no placeholder, no listener).
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

  test('main retains the pre-open advertise and the first project view replays it', async () => {
    await loadToolbar64(electronApp)

    // MAIN-SIDE RETENTION: poll the new getter from the main process. Returns
    // a sentinel instead of throwing while the getter does not exist so the
    // RED failure reads clearly.
    const retained = await pollUntil(
      () => electronApp.evaluate((_electronMods) => {
        const g = globalThis as unknown as {
          __e2eHostToolbarInstance: {
            context: { views: { getHostToolbarHeight?: () => number } }
          }
        }
        const views = g.__e2eHostToolbarInstance.context.views
        return typeof views.getHostToolbarHeight === 'function'
          ? views.getHostToolbarHeight()
          : ('MISSING-GETTER' as const)
      }),
      (v) => v === 64,
      20_000,
      300,
    )
    expect(
      retained,
      'views.getHostToolbarHeight() must retain the pre-open advertise (today the getter does not exist and the value is dropped)',
    ).toBe(64)

    // RENDERER REPLAY: opening the project mounts a fresh placeholder, which
    // must pull the retained 64 (the advertiser deduplicated long ago).
    await openProjectInUI(mainWindow, DEMO_APP_DIR, { waitMs: 20_000 })
    const height = await pollUntil(placeholderHeightOf(mainWindow), (v) => v === 64, 15_000, 300)
    expect(
      height,
      'the first project view after a cold-start advertise must replay the retained height',
    ).toBe(64)
  })
})
