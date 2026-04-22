import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * Drives the real GitHub Releases API for EchoTechFE/dimina-kit with
 * getCurrentVersion='0', so the `trailing-number` scheme always resolves
 * to a newer release (e.g. release-20260422-1 → version '1' > '0').
 *
 * Requires network access. Set GITHUB_TOKEN in the environment to avoid
 * unauthenticated rate limits.
 */
test.describe('Update dialog flow (real GitHub)', () => {
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

  test('dialog appears with the latest release version', async () => {
    await expect(mainWindow.getByText('Update Available')).toBeVisible({ timeout: 15_000 })
    // Version text comes from the real tag trailing number (e.g. release-…-1 → "1").
    await expect(mainWindow.getByText(/New version \d+ is available\./)).toBeVisible()
    await expect(mainWindow.getByRole('button', { name: 'Download' })).toBeVisible()
    await expect(mainWindow.getByRole('button', { name: 'Later' })).toBeVisible()
  })
})
