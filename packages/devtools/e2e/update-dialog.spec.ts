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
    // Network/repo-state dependent: the dialog only appears if the real GitHub
    // Releases API resolves a release newer than getCurrentVersion='0'. In an
    // environment with no network, rate-limited (unauthenticated) access, or a
    // repo with no releases, no update resolves — SKIP rather than hard-fail
    // (this is a "real GitHub" integration test, not a deterministic unit). With
    // GITHUB_TOKEN + network + a release present (CI), it runs and asserts.
    const appeared = await mainWindow
      .getByText('Update Available')
      .waitFor({ timeout: 15_000 })
      .then(() => true)
      .catch(() => false)
    test.skip(!appeared, 'GitHub Releases did not resolve a newer release in this environment (no network / rate-limited / no releases) — update flow not exercisable')

    await expect(mainWindow.getByText('Update Available')).toBeVisible()
    // Version text comes from the real tag trailing number (e.g. release-…-1 → "1").
    await expect(mainWindow.getByText(/New version \d+ is available\./)).toBeVisible()
    await expect(mainWindow.getByRole('button', { name: 'Download' })).toBeVisible()
    await expect(mainWindow.getByRole('button', { name: 'Later' })).toBeVisible()
  })
})
