import { _electron, expect, test, type ElectronApplication } from '@playwright/test'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const dataBase = (process.env.DIMINA_DEVTOOLS_DATA_DIR
  ?? (fs.existsSync('/Volumes/jdisk') ? '/Volumes/jdisk/electron-data/dimina-devtools-e2e' : null))
  ?? path.resolve(__dirname, '..', 'node_modules', '.cache', 'devtools-e2e')

/**
 * Proves the v2 framework-orchestrated path boots the FULL devtools runtime:
 * `@dimina-kit/electron-deck`'s `electronDeck()` runs the lifecycle gate + the devtools
 * `RuntimeBackend.beforeReady`/`assemble` build the real app (window + project
 * list), identical to the legacy `createWorkbenchApp` path.
 */
test.describe('launch() + RuntimeBackend (v2 framework orchestration)', () => {
  let app: ElectronApplication

  test.beforeAll(async () => {
    const entry = path.resolve(__dirname, 'workbench-backend-entry.js')
    const userDataDir = path.join(dataBase, 'userdata', 'workbench-backend-entry')
    fs.mkdirSync(userDataDir, { recursive: true })
    app = await _electron.launch({
      args: [entry, `--user-data-dir=${userDataDir}`],
      env: { ...process.env, NODE_ENV: 'test' },
    })
  })

  test.afterAll(async () => {
    await app?.close()
  })

  test('framework+backend boots a visible devtools main window', async () => {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    // Poll: the main window `show()`s slightly after domcontentloaded, and under
    // full-suite load that gap widens — retry rather than sample once.
    await expect.poll(() => app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some(w => w.isVisible())), { timeout: 10_000 },
    ).toBe(true)
  })

  test('beforeReady bootstrap set the Electron app name', async () => {
    const appName = await app.evaluate(({ app: a }) => a.getName())
    expect(appName).toBe('QDMP Backend Host')
  })

  test('full devtools runtime assembled (renderer mounts content)', async () => {
    const win = await app.firstWindow()
    await win.waitForSelector('body', { state: 'visible' })
    const hasContent = await win.evaluate(() =>
      document.body.innerText.length > 0 || document.body.children.length > 0)
    expect(hasContent).toBe(true)
  })
})
