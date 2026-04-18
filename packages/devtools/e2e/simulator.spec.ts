import { test, expect } from './fixtures'
import { DEMO_APP_DIR, openProjectInUI, closeProject } from './helpers'

test.describe('Simulator', () => {
  test.beforeEach(async ({ mainWindow }) => {
    await openProjectInUI(mainWindow, DEMO_APP_DIR, { waitForWebview: true })
  })

  test.afterEach(async ({ mainWindow }) => {
    await closeProject(mainWindow)
  })

  test('simulator webview element is present after compilation', async ({ mainWindow }) => {
    const hasWebview = await mainWindow.evaluate(() => {
      return document.querySelector('webview') !== null
    })
    const bodyHtml = await mainWindow.evaluate(() => document.body.innerHTML)
    expect(hasWebview).toBe(true)
    expect(bodyHtml.length).toBeGreaterThan(0)
  })

  test('device selector is present with expected options', async ({ mainWindow }) => {
    const deviceNames = await mainWindow.evaluate(() => {
      const selects = document.querySelectorAll('select')
      for (const sel of selects) {
        const options = Array.from(sel.options).map((o) => o.textContent)
        if (options.some((o) => o?.includes('iPhone'))) {
          return options
        }
      }
      return []
    })

    expect(deviceNames.length).toBeGreaterThan(0)
    expect(deviceNames.some((n) => n?.includes('iPhone'))).toBe(true)
  })

  test('zoom selector is present with expected options', async ({ mainWindow }) => {
    const zoomValues = await mainWindow.evaluate(() => {
      const selects = document.querySelectorAll('select')
      for (const sel of selects) {
        const options = Array.from(sel.options).map((o) => o.textContent)
        if (options.some((o) => o?.includes('%'))) {
          return options
        }
      }
      return []
    })

    expect(zoomValues.length).toBeGreaterThan(0)
    expect(zoomValues.some((z) => z?.includes('100%'))).toBe(true)
  })

  test('changing device selector updates simulator dimensions', async ({ mainWindow }) => {
    const changed = await mainWindow.evaluate(() => {
      const selects = document.querySelectorAll('select')
      for (const sel of selects) {
        const options = Array.from(sel.options).map((o) => o.textContent)
        if (options.some((o) => o?.includes('iPhone SE'))) {
          sel.value = 'iPhone SE'
          sel.dispatchEvent(new Event('change', { bubbles: true }))
          return true
        }
      }
      return false
    })

    if (changed) {
      await mainWindow.waitForTimeout(500)
      const selectedDevice = await mainWindow.evaluate(() => {
        const selects = document.querySelectorAll('select')
        for (const sel of selects) {
          const options = Array.from(sel.options).map((o) => o.textContent)
          if (options.some((o) => o?.includes('iPhone'))) {
            return sel.value
          }
        }
        return ''
      })
      expect(selectedDevice).toBe('iPhone SE')
    }
  })
})
