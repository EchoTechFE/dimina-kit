import { _electron, expect, test, type ElectronApplication } from '@playwright/test'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Keep per-test Electron userData off the constrained system partition, mirroring
// fixtures.ts (Chromium cache / IndexedDB are ~100MB).
const dataBase = (process.env.DIMINA_DEVTOOLS_DATA_DIR
  ?? (fs.existsSync('/Volumes/jdisk') ? '/Volumes/jdisk/electron-data/dimina-devtools-e2e' : null))
  ?? path.resolve(__dirname, '..', 'node_modules', '.cache', 'devtools-e2e')

/**
 * Proves the declarative `workbench(config)` host-shell entry boots the real
 * devtools runtime end-to-end (the other 80 e2e tests all go through the default
 * `launch()` path; this is the only coverage that actually runs `workbench()`).
 */
test.describe('workbench(config) host-shell entry', () => {
  let app: ElectronApplication

  test.beforeAll(async () => {
    const entry = path.resolve(__dirname, 'workbench-config-entry.js')
    const userDataDir = path.join(dataBase, 'userdata', 'workbench-config-entry')
    fs.mkdirSync(userDataDir, { recursive: true })
    app = await _electron.launch({
      args: [entry, `--user-data-dir=${userDataDir}`],
      env: { ...process.env, NODE_ENV: 'test' },
    })
  })

  test.afterAll(async () => {
    await app?.close()
  })

  test('boots a visible main window through workbench(config)', async () => {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    const isVisible = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.isVisible() ?? false)
    expect(isVisible).toBe(true)
  })

  test('config.app.name flows through to the Electron app name + window title', async () => {
    const win = await app.firstWindow()
    const appName = await app.evaluate(({ app: a }) => a.getName())
    expect(appName).toBe('QDMP Test Host')
    expect(await win.title()).toContain('QDMP Test Host')
  })

  test('setup(runtime) ran with a real runtime facade', async () => {
    const probe = await app.evaluate(() => globalThis.__workbenchE2E)
    expect(probe?.setupRan).toBe(true)
    expect(probe?.hasContext).toBe(true)
    expect(probe?.hasWorkspace).toBe(true)
    expect(probe?.activeProjectPath).toBeNull() // no project opened yet
    expect(probe?.hasElectronApp).toBe(true)
    expect(probe?.hasMainWindow).toBe(true)
  })

  test('config-declared simulatorApi is wired into the runtime (call.simulator → result)', async () => {
    // The config declared simulatorApis.hostPing; invoking it through
    // runtime.call.simulator at setup time must reach the registered handler.
    const probe = await app.evaluate(() => globalThis.__workbenchE2E)
    expect(probe?.simulatorPing).toBe('pong')
  })
})
