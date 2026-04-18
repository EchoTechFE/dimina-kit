/**
 * Automator — launches the devtools Electron app and returns a MiniProgram instance.
 *
 * Usage:
 *   const miniProgram = await Automator.launch({ projectPath: '/path/to/demo-app' })
 *   const page = await miniProgram.currentPage()
 *   await miniProgram.close()
 */

import { _electron, type ElectronApplication, type Page as PwPage } from '@playwright/test'
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
    } = options

    // Launch Electron
    const electronApp = await _electron.launch({
      args: [electronEntry],
      env: { ...process.env, NODE_ENV: 'test' },
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
