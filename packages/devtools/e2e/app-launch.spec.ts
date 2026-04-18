import { test, expect } from './fixtures'

test.describe('App Launch', () => {
  test('app launches and window is visible', async ({ electronApp, mainWindow }) => {
    // The main window should exist
    expect(mainWindow).toBeTruthy()

    // Check the window is visible via the main process
    const isVisible = await electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      return win?.isVisible() ?? false
    })
    expect(isVisible).toBe(true)
  })

  test('window has correct title', async ({ mainWindow }) => {
    const title = await mainWindow.title()
    expect(title).toContain('Dimina DevTools')
  })

  test('main window dimensions are at least 1000x600', async ({ electronApp, mainWindow }) => {
    // mainWindow fixture ensures the window is visible before checking bounds
    void mainWindow
    const { width, height } = await electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      const bounds = win?.getBounds() ?? { width: 0, height: 0 }
      return { width: bounds.width, height: bounds.height }
    })
    expect(width).toBeGreaterThanOrEqual(1000)
    expect(height).toBeGreaterThanOrEqual(600)
  })

  test('project list UI or initial state renders', async ({ mainWindow }) => {
    // The app should render something — either the project list or initial view.
    // Wait for the React app to mount by checking for any visible content.
    await mainWindow.waitForSelector('body', { state: 'visible' })

    // The body should have content (React has mounted)
    const bodyContent = await mainWindow.evaluate(() => {
      return document.body.innerText.length > 0 || document.body.children.length > 0
    })
    expect(bodyContent).toBe(true)
  })
})
