import { test as base, _electron, type ElectronApplication, type Page } from '@playwright/test'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * Custom Playwright fixtures for the Dimina DevTools Electron app.
 *
 * Provides:
 * - `electronApp`: launched Electron application instance
 * - `mainWindow`: the first (main) BrowserWindow page, visible and loaded
 */

export interface ElectronFixtures {
  electronApp: ElectronApplication
  mainWindow: Page
}

export const test = base.extend<ElectronFixtures>({
  // eslint-disable-next-line no-empty-pattern
  electronApp: async ({}, use) => {
    const appPath = path.resolve(__dirname, 'electron-entry.js')

    const electronApp = await _electron.launch({
      args: [appPath],
      env: {
        ...process.env,
        NODE_ENV: 'test',
      },
    })

    await use(electronApp)

    await electronApp.close().catch(() => {})
  },

  mainWindow: async ({ electronApp }, use) => {
    const mainWindow = await electronApp.firstWindow()
    await mainWindow.waitForLoadState('domcontentloaded')

    // Wait for the BrowserWindow to become visible, then move it off-screen
    // and blur it so it does not steal user focus during e2e runs.
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

    await use(mainWindow)
  },
})

/**
 * Find a window by matching its URL against a pattern.
 */
export async function findWindowByUrl(
  electronApp: ElectronApplication,
  urlPattern: RegExp
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

export { expect } from '@playwright/test'
