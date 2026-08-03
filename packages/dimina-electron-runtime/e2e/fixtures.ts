import { test as base, expect, _electron, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { closeProject, resetSimulatorState } from './helpers'
import { armMaxListenersGuard, type MaxListenersGuard } from './resource-guards'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * Custom Playwright fixtures for @dimina-kit/electron-runtime's own e2e suite.
 *
 * Mirrors packages/devtools/e2e/fixtures.ts's worker-scoped Electron process
 * pattern (one Electron process per Playwright worker, its own
 * `--user-data-dir`), but there is no project-list UI here — a project opens
 * via `globalThis.__diminaE2eHooks.openProject(...)` (see electron-entry.js),
 * driven directly through `electronApp.evaluate()`.
 */

export interface ElectronFixtures {
  electronApp: ElectronApplication
  mainWindow: Page
  /**
   * Auto fixture (leak gate): fails any test during which the Electron app's
   * stderr printed a MaxListenersExceededWarning — a leaked-listener class that
   * memory metrics can't see. Depend on it implicitly; never reference it.
   */
  _maxListenersGate: void
}

export interface ElectronWorkerFixtures {
  // _workerElectron is internal — tests should depend on `electronApp` (test-scoped wrapper).
  _workerElectron: WorkerElectronHandle
}

interface WorkerElectronHandle {
  app: ElectronApplication
  /** Force-relaunch the Electron process, replacing the held instance. */
  relaunch: () => Promise<void>
  userDataDir: string
  /** stderr MaxListenersExceededWarning collector for the CURRENT app instance. */
  guard: MaxListenersGuard
}

function userDataDirFor(workerIndex: number): string {
  const base = process.env.DIMINA_DEVTOOLS_DATA_DIR
    ?? path.resolve(__dirname, '..', 'node_modules', '.cache', 'electron-runtime-e2e')
  const dir = path.join(base, 'userdata', `worker-${workerIndex}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

async function launchElectron(userDataDir: string): Promise<ElectronApplication> {
  const appPath = path.resolve(__dirname, 'electron-entry.js')
  const electronApp = await _electron.launch({
    args: [appPath, `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DIMINA_E2E_USER_DATA_DIR: userDataDir,
    },
  })

  const mainWindow = await electronApp.firstWindow()
  await mainWindow.waitForLoadState('domcontentloaded')

  // Move off-screen + blur so the test windows don't steal focus.
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

  return electronApp
}

async function isHealthy(app: ElectronApplication, win: Page | undefined): Promise<boolean> {
  try {
    if (!app) return false
    if (app.windows().length === 0) return false
    if (!win) return false
    if (win.isClosed()) return false
    // The runtime installs its test hooks synchronously during startup — a
    // cheap, always-available liveness probe (no project needs to be open).
    return await app.evaluate(() => typeof (globalThis as Record<string, unknown>).__diminaE2eHooks !== 'undefined')
  } catch {
    return false
  }
}

export const test = base.extend<ElectronFixtures, ElectronWorkerFixtures>({
  _workerElectron: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use, workerInfo) => {
      const userDataDir = userDataDirFor(workerInfo.workerIndex)

      let app = await launchElectron(userDataDir)
      let guard = armMaxListenersGuard(app)

      const handle: WorkerElectronHandle = {
        get app() {
          return app
        },
        relaunch: async () => {
          await app.close().catch(() => {})
          app = await launchElectron(userDataDir)
          guard = armMaxListenersGuard(app)
        },
        userDataDir,
        get guard() {
          return guard
        },
      } as WorkerElectronHandle

      await use(handle)

      await app.close().catch(() => {})
    },
    { scope: 'worker' },
  ],

  electronApp: async ({ _workerElectron }, use) => {
    await use(_workerElectron.app)
  },

  mainWindow: async ({ _workerElectron }, use) => {
    let win = await _workerElectron.app.firstWindow()
    if (!(await isHealthy(_workerElectron.app, win))) {
      await _workerElectron.relaunch()
      win = await _workerElectron.app.firstWindow()
      await win.waitForLoadState('domcontentloaded')
    }
    await use(win)
  },

  _maxListenersGate: [
    async ({ _workerElectron }, use) => {
      const seenBefore = _workerElectron.guard.warnings().length
      await use(undefined)
      const during = _workerElectron.guard.warnings().slice(seenBefore)
      expect(
        during,
        'the app emitted MaxListenersExceededWarning during this test — a listener leaked on a shared emitter',
      ).toEqual([])
    },
    { auto: true },
  ],
})

/**
 * Find a window by matching its URL against a pattern.
 */
export async function findWindowByUrl(
  electronApp: ElectronApplication,
  urlPattern: RegExp,
): Promise<Page | undefined> {
  const windows = electronApp.windows()
  for (const win of windows) {
    const url = win.url()
    if (urlPattern.test(url)) {
      return win
    }
  }
  return undefined
}

/**
 * Share one opened project across every test in the calling spec file.
 *
 * Call this at the top of a `test.describe` block (or top-level of the file).
 * It registers `beforeAll`/`afterAll`/`afterEach` hooks against the passed
 * `test` object. Inside each test you can keep using the standard
 * `mainWindow` / `electronApp` fixtures — the project is already open.
 *
 * Options:
 * - `openOptions`  — forwarded to the runtime's `openProject` hook. Default `{}`.
 */
export interface UseSharedProjectOptions {
  openOptions?: Record<string, unknown>
}

export function useSharedProject(
  testObj: typeof test,
  projectDir: string,
  options: UseSharedProjectOptions = {},
): void {
  const { openOptions } = options

  testObj.beforeAll(async ({ _workerElectron }) => {
    await _workerElectron.app.evaluate(
      async (_electron, { projectDir, openOptions }) => {
        const hooks = (globalThis as Record<string, unknown>).__diminaE2eHooks as {
          openProject: (dir: string, opts?: Record<string, unknown>) => Promise<unknown>
        }
        await hooks.openProject(projectDir, openOptions)
      },
      { projectDir, openOptions },
    )
  })

  testObj.afterEach(async ({ electronApp }) => {
    await resetSimulatorState(electronApp)
  })

  testObj.afterAll(async ({ electronApp }) => {
    await closeProject(electronApp).catch(() => {})
  })
}

export { expect } from '@playwright/test'
