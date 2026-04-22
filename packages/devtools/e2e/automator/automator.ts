/**
 * Automator — launches the devtools Electron app and returns a MiniProgram instance.
 *
 * Usage:
 *   const miniProgram = await Automator.launch({ projectPath: '/path/to/demo-app' })
 *   const page = await miniProgram.currentPage()
 *   await miniProgram.close()
 */

import { _electron, type ElectronApplication, type Page as PwPage } from '@playwright/test'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { MiniProgram } from './mini-program'
import { openProjectInUI, waitForSimulatorWebview } from '../helpers'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export interface AutomatorLaunchOptions {
  /** Path to the mini program project directory (must contain project.config.json). */
  projectPath: string
  /** Path to the Electron entry script. Defaults to e2e/electron-entry.js. */
  electronEntry?: string
  /** Time to wait for compilation after opening the project (ms). Default 8000. */
  compileWaitMs?: number
  /** Whether to wait for the simulator webview to appear. Default true. */
  waitForWebview?: boolean
  /**
   * Playwright worker index (or any unique slot id). Used to compute a
   * per-worker `--user-data-dir` so parallel Electron processes don't clobber
   * each other's projects.json / settings. Defaults to 0.
   */
  workerIndex?: number
}

export function automatorUserDataDir(workerIndex: number): string {
  const dir = path.resolve(
    __dirname,
    '..',
    '..',
    'node_modules',
    '.cache',
    'devtools-e2e',
    'userdata',
    `automator-worker-${workerIndex}`,
  )
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export class Automator {
  /**
   * Launch the devtools with a mini program project and return a MiniProgram handle.
   */
  static async launch(options: AutomatorLaunchOptions): Promise<MiniProgram> {
    const {
      projectPath,
      electronEntry = path.resolve(__dirname, '..', 'electron-entry.js'),
      compileWaitMs = 8000,
      waitForWebview = true,
      workerIndex = 0,
    } = options

    const userDataDir = automatorUserDataDir(workerIndex)

    // Launch Electron
    const electronApp = await _electron.launch({
      args: [electronEntry, `--user-data-dir=${userDataDir}`],
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DIMINA_E2E_USER_DATA_DIR: userDataDir,
      },
    })

    // Wait for the main window
    const mainWindow = await electronApp.firstWindow()
    await mainWindow.waitForLoadState('domcontentloaded')

    // Move off-screen so it doesn't steal focus
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

    // Open the project
    await openProjectInUI(mainWindow, projectPath, {
      waitMs: compileWaitMs,
      waitForWebview,
    })

    if (waitForWebview) {
      await waitForSimulatorWebview(electronApp)
    }

    return new MiniProgram(electronApp, mainWindow, projectPath)
  }

  /**
   * Connect to an already-running devtools instance.
   * Requires electronApp and mainWindow from Playwright fixtures.
   */
  static connect(
    electronApp: ElectronApplication,
    mainWindow: PwPage,
    projectPath: string,
  ): MiniProgram {
    return new MiniProgram(electronApp, mainWindow, projectPath)
  }
}
