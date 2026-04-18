import { test, expect } from './fixtures'
import {
  DEMO_APP_DIR,
  openProjectInUI,
  closeProject,
  findButtonByText,
  findButtonByTitle,
} from './helpers'

test.describe('Simulator Panel', () => {
  test.beforeEach(async ({ mainWindow }) => {
    await openProjectInUI(mainWindow, DEMO_APP_DIR, { waitForWebview: true })
  })

  test.afterEach(async ({ mainWindow }) => {
    await closeProject(mainWindow)
  })

  test('toolbar has compile and simulator toggle buttons', async ({ mainWindow }) => {
    expect(await findButtonByText(mainWindow, '普通编译')).toBe(true)
    expect(await findButtonByTitle(mainWindow, '面板')).toBe(true)
  })

  test('toolbar has built-in right panel tabs', async ({ mainWindow }) => {
    const tabLabels = await mainWindow.evaluate(() => {
      const buttons = document.querySelectorAll('button')
      const labels: string[] = []
      buttons.forEach((btn) => {
        const text = btn.textContent?.trim()
        if (text && ['WXML', 'AppData', 'Storage'].includes(text)) {
          labels.push(text)
        }
      })
      return labels
    })

    expect(tabLabels).toEqual(expect.arrayContaining(['WXML', 'AppData', 'Storage']))
  })

  test('can toggle simulator panel visibility', async ({ mainWindow, electronApp }) => {
    const getChildCount = () =>
      electronApp.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0]
        return win ? (win.contentView.children || []).length : 0
      })

    const before = await getChildCount()
    const toggleFound = await mainWindow.evaluate(() => {
      const buttons = document.querySelectorAll('button')
      for (const btn of buttons) {
        const title = btn.getAttribute('title') || ''
        if (title.includes('面板')) {
          btn.click()
          return true
        }
      }
      return false
    })
    expect(toggleFound).toBe(true)

    await mainWindow.waitForTimeout(500)
    const hiddenCount = await getChildCount()
    expect(hiddenCount).toBeLessThan(before)

    // Click again to toggle back
    await mainWindow.evaluate(() => {
      const buttons = document.querySelectorAll('button')
      for (const btn of buttons) {
        const title = btn.getAttribute('title') || ''
        if (title.includes('面板')) {
          btn.click()
          return true
        }
      }
      return false
    })
    await mainWindow.waitForTimeout(500)
    const shownCount = await getChildCount()
    expect(shownCount).toBeGreaterThan(hiddenCount)
  })

  test('right panel tabs are rendered in the main window', async ({ mainWindow }) => {
    const tabLabels = await mainWindow.evaluate(() => {
      const buttons = document.querySelectorAll('button')
      const labels: string[] = []
      buttons.forEach((btn) => {
        const text = btn.textContent?.trim()
        if (text && ['WXML', 'AppData', 'Storage'].includes(text)) {
          labels.push(text)
        }
      })
      return labels
    })
    expect(tabLabels.length).toBeGreaterThan(0)
  })
})
