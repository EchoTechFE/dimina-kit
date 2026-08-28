import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test'
import path from 'path'
import { fileURLToPath } from 'url'
import { evalInWebContentsByUrl, pollUntil, findMainWindow } from './helpers'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** Read the update-dialog's own document (`entries/update-dialog`), not the main window — the dialog moved into its own WCV to fix the native-overlay occlusion bug (see `view-manager-dialog-zorder.test.ts`). */
function updateDialogBodyText(electronApp: ElectronApplication): Promise<string> {
  return evalInWebContentsByUrl<string>(electronApp, 'entries/update-dialog', 'document.body.innerText')
}

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
    mainWindow = await findMainWindow(electronApp)
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
    //
    // The dialog itself lives in its own `entries/update-dialog` WCV, not the
    // main window's renderer — until that WCV exists (only once `showUpdatePanel`
    // has actually fired), `evalInWebContentsByUrl` throws "No webContents
    // found", which `pollUntil` swallows on every attempt but the retry loop's
    // timeout.
    const appeared = await pollUntil(
      () => updateDialogBodyText(electronApp),
      (text) => text.includes('Update Available'),
      15_000,
      500,
    ).then((text) => text.includes('Update Available')).catch(() => false)
    test.skip(!appeared, 'GitHub Releases did not resolve a newer release in this environment (no network / rate-limited / no releases) — update flow not exercisable')

    const bodyText = await updateDialogBodyText(electronApp)
    expect(bodyText).toContain('Update Available')
    // Version text comes from the real tag trailing number (e.g. release-…-1 → "1").
    expect(bodyText).toMatch(/New version \d+ is available\./)

    const buttonTexts = await evalInWebContentsByUrl<string[]>(
      electronApp,
      'entries/update-dialog',
      `Array.from(document.querySelectorAll('button')).map((b) => b.textContent || '')`,
    )
    expect(buttonTexts.some((t) => t.includes('Download'))).toBe(true)
    expect(buttonTexts.some((t) => t.includes('Later'))).toBe(true)
  })
})
