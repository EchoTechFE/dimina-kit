import { test as base, _electron, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { ProjectsChannel } from '../src/shared/ipc-channels'
import { ipcInvoke, openProjectInUI, closeProject, resetSimulatorState } from './helpers'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * Custom Playwright fixtures for the Dimina DevTools Electron app.
 *
 * Architecture:
 * - `electronApp` is **worker-scoped**: one Electron process per Playwright worker,
 *   reused across all tests that run in that worker. Each worker uses its own
 *   `--user-data-dir` so workers don't fight over Electron singleton locks,
 *   project lists, or settings files.
 * - `mainWindow` is **test-scoped** but does NOT relaunch Electron — it grabs the
 *   existing first window from the worker-scoped app and runs a quick health
 *   check (window alive + IPC ping). On failure it triggers a relaunch.
 *
 * Spec authors who want to share a single opened project across all tests in
 * one spec file should use {@link useSharedProject} (see its JSDoc for usage).
 */

export interface ElectronFixtures {
  electronApp: ElectronApplication
  mainWindow: Page
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
}

function userDataDirFor(workerIndex: number): string {
  const dir = path.resolve(
    __dirname,
    '..',
    'node_modules',
    '.cache',
    'devtools-e2e',
    'userdata',
    `worker-${workerIndex}`,
  )
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
      // Forwarded to the main process in case the app prefers an env var over the CLI switch.
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
    // One quick IPC ping — projects:list is read-only and always registered.
    await ipcInvoke(win, ProjectsChannel.List)
    return true
  } catch {
    return false
  }
}

export const test = base.extend<ElectronFixtures, ElectronWorkerFixtures>({
  _workerElectron: [
    async ({}, use, workerInfo) => {
      const userDataDir = userDataDirFor(workerInfo.workerIndex)

      let app = await launchElectron(userDataDir)

      const handle: WorkerElectronHandle = {
        get app() {
          return app
        },
        relaunch: async () => {
          await app.close().catch(() => {})
          app = await launchElectron(userDataDir)
        },
        userDataDir,
      } as WorkerElectronHandle

      await use(handle)

      await app.close().catch(() => {})
    },
    { scope: 'worker' },
  ],

  electronApp: async ({ _workerElectron }, use) => {
    // Expose the worker-scoped Electron app to tests as if it were test-scoped.
    // The mainWindow fixture below is responsible for health-checking & relaunching.
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
 * Between tests it clears `wx` storage and navigates the simulator back to
 * the configured home page. This is best-effort: a test that leaves the
 * simulator in an unreachable state (e.g. crashed webview) will still
 * benefit from the worker-scoped Electron health check on the next
 * `mainWindow` acquisition.
 *
 * Usage:
 *
 * ```ts
 * import { test, expect, useSharedProject } from './fixtures'
 * import { DEMO_APP_DIR } from './helpers'
 *
 * test.describe('My feature', () => {
 *   useSharedProject(test, DEMO_APP_DIR)
 *
 *   test('does a thing', async ({ mainWindow, electronApp }) => {
 *     // project is already open; just exercise it.
 *   })
 * })
 * ```
 *
 * Options:
 * - `homePagePath` — page to reset to between tests. Default `'pages/index/index'`.
 * - `openOptions`  — forwarded to `openProjectInUI`. Default `{}`.
 */
export interface UseSharedProjectOptions {
  homePagePath?: string
  openOptions?: Parameters<typeof openProjectInUI>[2]
}

export function useSharedProject(
  testObj: typeof test,
  projectDir: string,
  options: UseSharedProjectOptions = {},
): void {
  const { homePagePath = 'pages/index/index', openOptions } = options

  // beforeAll/afterAll only receive worker-scoped fixtures, so we rely on
  // _workerElectron and grab the firstWindow ourselves.
  testObj.beforeAll(async ({ _workerElectron }) => {
    const win = await _workerElectron.app.firstWindow()
    await openProjectInUI(win, projectDir, openOptions)
  })

  testObj.afterEach(async ({ electronApp }) => {
    await resetSimulatorState(electronApp, homePagePath)
  })

  testObj.afterAll(async ({ _workerElectron }) => {
    const win = await _workerElectron.app.firstWindow().catch(() => undefined)
    if (win && !win.isClosed()) {
      await closeProject(win).catch(() => {})
    }
  })
}

export { expect } from '@playwright/test'
