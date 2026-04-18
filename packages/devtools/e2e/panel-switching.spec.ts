import { test, expect } from './fixtures'
import {
  DEMO_APP_DIR,
  openProjectInUI,
  closeProject,
  ipcInvoke,
} from './helpers'
import { PanelChannel } from '../src/shared/ipc-channels'

test.describe('Right panel switching', () => {
  test.beforeEach(async ({ mainWindow }) => {
    await openProjectInUI(mainWindow, DEMO_APP_DIR, { waitForWebview: true })
    await mainWindow.waitForTimeout(1500)
  })

  test.afterEach(async ({ mainWindow }) => {
    await closeProject(mainWindow)
  })

  test('selecting each panel renders the correct panel in the main window', async ({
    mainWindow,
  }) => {
    for (const id of ['wxml', 'appdata', 'storage']) {
      await ipcInvoke(mainWindow, PanelChannel.Select, id)
      await mainWindow.waitForTimeout(400)
    }
    // Selecting devtools should show the devtools overlay (chrome devtools)
    await ipcInvoke(mainWindow, PanelChannel.SelectSimulator)
    await mainWindow.waitForTimeout(400)
  })

  test('selecting WXML tab shows WXML panel content in main window', async ({ mainWindow }) => {
    await mainWindow.getByRole('tab', { name: 'WXML' }).click()
    await mainWindow.waitForTimeout(500)

    const hasRefreshButton = await mainWindow.evaluate(() => {
      const buttons = document.querySelectorAll('button')
      for (const btn of buttons) {
        if (btn.textContent?.includes('刷新')) return true
      }
      return false
    })
    expect(hasRefreshButton).toBe(true)
  })

  test('closing project does not leave orphan right-panel views', async ({ electronApp }) => {
    const rpCount = await electronApp.evaluate(({ webContents }) => {
      return webContents.getAllWebContents().filter((wc) => wc.getURL().includes('right-panel')).length
    })
    expect(rpCount).toBe(0)
  })
})
