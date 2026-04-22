import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

test.describe('Update dialog flow', () => {
  let electronApp: ElectronApplication
  let mainWindow: Page

  test.beforeAll(async () => {
    const entryPath = path.resolve(__dirname, 'update-entry.js')
    electronApp = await _electron.launch({
      args: [entryPath],
      env: {
        ...process.env,
        NODE_ENV: 'test',
      },
    })
    mainWindow = await electronApp.firstWindow()
    await mainWindow.waitForLoadState('domcontentloaded')
  })

  test.afterAll(async () => {
    await electronApp?.close().catch(() => {})
  })

  test('dialog appears when an update is available', async () => {
    await expect(mainWindow.getByText('Update Available')).toBeVisible({ timeout: 10_000 })
    await expect(mainWindow.getByText('New version 9.9.9 is available.')).toBeVisible()
    await expect(mainWindow.getByText(/Synthetic release notes/)).toBeVisible()
    await expect(mainWindow.getByRole('button', { name: 'Download' })).toBeVisible()
    await expect(mainWindow.getByRole('button', { name: 'Later' })).toBeVisible()
  })

  test('download transitions to ready-to-install', async () => {
    await mainWindow.getByRole('button', { name: 'Download' }).click()

    // The dialog may briefly show "Downloading..." depending on timing, then "Ready to Install".
    await expect(mainWindow.getByText('Ready to Install')).toBeVisible({ timeout: 5_000 })
    await expect(mainWindow.getByRole('button', { name: /Install & Restart/ })).toBeVisible()
    // Do NOT click Install — it would quit the app via app.quit() and break subsequent tests.
  })
})
