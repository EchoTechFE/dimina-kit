import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test'
import path from 'path'
import { fileURLToPath } from 'url'
import { DEMO_APP_DIR, openProjectInUI, pollUntil } from './helpers'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.resolve(__dirname, 'fixtures', 'host-toolbar')

/**
 * Host-toolbar height RETENTION (real app).
 *
 * `views.getHostToolbarHeight()` keeps the last height a toolbar WCV
 * advertised, independent of whether a renderer is currently listening for
 * the push. The renderer's `[data-area="host-toolbar"]` placeholder PULLS
 * this value on mount (the `view:host-toolbar:get-height` invoke) instead of
 * relying solely on the push, because advertise and mount are two
 * independent timelines within one window's boot: the toolbar WCV's
 * size-advertiser deduplicates (a height already reported is never
 * re-sent), so a push that lands before the placeholder has mounted — or
 * before its height listener is wired up — needs a way to be recovered
 * rather than lost the moment the dedupe kicks in.
 *
 * "Toolbar alive, placeholder gone" is not a reachable state: a workbench
 * window's toolbar WCV and its placeholder are mounted by the same
 * `ProjectRuntime`, in the same window, and the only way to unmount the
 * placeholder is to destroy the window, which takes the toolbar with it. So
 * the ordering this spec has to cover is the one inside a single window's own
 * boot: load content into the toolbar, confirm the placeholder reflects it,
 * and confirm main retained the same value the renderer pulled.
 *
 * Reuses `host-toolbar-entry.js` (stock `launch()` exposing the instance on
 * globalThis) and the host-toolbar fixtures. Electron e2e; runs on local
 * macOS without extra setup (NODE_ENV=test, off-screen windows).
 */

interface HostToolbarInstance {
  projectWindows(): Array<{
    context: {
      views: {
        hostToolbar: { loadFile(p: string): Promise<void> }
        getHostToolbarHeight(): number
      }
    }
  }>
}

test.describe('Host toolbar height retention', () => {
  test.setTimeout(120_000)
  test.describe.configure({ mode: 'serial' })

  let electronApp: ElectronApplication
  let workbench: Page

  test.beforeAll(async () => {
    const entryPath = path.resolve(__dirname, 'host-toolbar-entry.js')
    electronApp = await _electron.launch({
      args: [entryPath],
      env: {
        ...process.env,
        NODE_ENV: 'test',
      },
    })
    workbench = await openProjectInUI(electronApp, DEMO_APP_DIR, { waitMs: 20_000 })
  })

  test.afterAll(async () => {
    await Promise.race([
      electronApp?.close().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 15_000)),
    ])
  })

  /** Measured height of the workbench window's toolbar placeholder (CSS px, rounded). */
  const placeholderHeight = () => workbench.evaluate(() => {
    const el = document.querySelector('[data-area="host-toolbar"]')
    return el ? Math.round(el.getBoundingClientRect().height) : -1
  })

  test('the advertised height reaches the placeholder and is retained for the window it belongs to', async () => {
    await electronApp.evaluate((_electronMods, file) => {
      const g = globalThis as unknown as { __e2eHostToolbarInstance: HostToolbarInstance }
      return g.__e2eHostToolbarInstance.projectWindows()[0].context.views.hostToolbar.loadFile(file)
    }, path.join(FIXTURES, 'toolbar-64.html'))

    const height = await pollUntil(placeholderHeight, (v) => v === 64, 30_000, 300)
    expect(height, 'the advertise → notify → placeholder loop must land 64').toBe(64)

    // THE RETENTION ASSERTION: main keeps the same value the placeholder just
    // pulled, scoped to the window whose toolbar advertised it.
    const retained = await pollUntil(
      () => electronApp.evaluate(() => {
        const g = globalThis as unknown as { __e2eHostToolbarInstance: HostToolbarInstance }
        return g.__e2eHostToolbarInstance.projectWindows()[0].context.views.getHostToolbarHeight()
      }),
      (v) => v === 64,
      15_000,
      300,
    )
    expect(retained, 'the retention getter must keep the last height advertised in this window').toBe(64)
  })
})
