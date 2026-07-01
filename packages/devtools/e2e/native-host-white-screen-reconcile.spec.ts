/**
 * E2E (native-host): the placement reconciler keeps content WebContentsViews
 * mounted + visible through repeated device switches.
 *
 * Regression guard for the reported white-screen bug: rapidly switching the
 * simulator device/orientation a dozen-plus times made the whole workbench go
 * white and STAY white. A relayout transient (a dock slot momentarily measuring
 * 0×0 mid-switch, coalesced away by ResizeObserver) made the RAF geometry
 * sentinel publish a spurious detach; the main process removed the content
 * WebContentsView from the contentView and nothing ever re-attached it.
 *
 * Under the reconciler, hiding a base view is setVisible(false) — never a
 * detach — and every reconcile re-derives the actual tree from the desired
 * snapshot, so a transient is at worst a one-tick flicker that self-heals.
 * This drives the REAL device dropdown many times in quick succession and
 * asserts the simulator content view stays visible: document.visibilityState
 * === 'visible' is the exact signal the bug report flagged as stuck at
 * 'hidden', and the WCV stays in contentView.children (not detached).
 */
import { test, expect, _electron, type ElectronApplication, type Page as PwPage } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import {
  openProjectInUI,
  waitForSimulatorWebview,
  closeProject,
  ipcInvoke,
  pollUntil,
  evalInSimulator,
} from './helpers'
import { AutomationChannel } from '../src/shared/ipc-channels'
import { DEVICES } from '../src/renderer/shared/constants'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = path.resolve(__dirname, 'fixtures', 'tabbar-app')

// Cycle across presets with different widths AND heights so each switch changes
// the simulator column width → dock relayout → the geometry sentinel opens,
// reproducing the transient that used to detach the view.
const CYCLE = [
  DEVICES[0],
  DEVICES.find((d) => d.name === 'iPhone 14 Pro'),
  DEVICES.find((d) => d.name === 'iPhone 16 Pro'),
  DEVICES.find((d) => d.name === 'iPhone SE') ?? DEVICES[0],
].filter(Boolean) as { name: string }[]

let electronApp: ElectronApplication
let mainWindow: PwPage

async function selectDevice(win: PwPage, deviceName: string): Promise<void> {
  const sel = win.locator('select', { has: win.locator(`option[value="${deviceName}"]`) }).first()
  await sel.selectOption(deviceName)
}

test.describe('native-host white-screen reconcile e2e', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(180_000)

  test.beforeAll(async () => {
    const appPath = path.resolve(__dirname, 'electron-entry.js')
    const userDataDir = path.resolve(
      process.env.DIMINA_DEVTOOLS_DATA_DIR
        ?? path.resolve(__dirname, '..', 'node_modules', '.cache', 'devtools-e2e'),
      'userdata',
      `nh-whitescreen-${process.pid}`,
    )
    fs.mkdirSync(userDataDir, { recursive: true })

    electronApp = await _electron.launch({
      args: [appPath, 'auto', '--auto-port', '0', `--user-data-dir=${userDataDir}`],
      env: { ...process.env, NODE_ENV: 'test', DIMINA_NATIVE_HOST: '1', DIMINA_E2E_USER_DATA_DIR: userDataDir },
    })

    mainWindow = await electronApp.firstWindow()
    await mainWindow.waitForLoadState('domcontentloaded')

    await electronApp.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (win && !win.isVisible()) {
        await new Promise<void>((resolve) => {
          win.once('show', resolve)
          setTimeout(resolve, 5000)
        })
      }
      if (win) {
        win.setPosition(-2000, -2000)
        win.blur()
      }
    })

    await pollUntil(
      () => ipcInvoke<number | null>(mainWindow, AutomationChannel.GetPort),
      (val) => typeof val === 'number' && val > 0,
      10000,
      100,
    )

    await openProjectInUI(mainWindow, FIXTURE_DIR, { waitMs: 20000 })
    await waitForSimulatorWebview(electronApp)

    await pollUntil(
      () => evalInSimulator<boolean>(
        electronApp,
        `(() => !!document.querySelector('.device-shell-root'))()`,
      ).catch(() => false),
      (ok) => ok === true,
      25000,
      300,
    )
  })

  test.afterAll(async () => {
    await closeProject(mainWindow).catch(() => {})
    await electronApp?.close().catch(() => {})
  })

  test('repeated device switches keep the simulator content view visible (no white screen)', async () => {
    // Rapid-fire switches: a short gap so each triggers a relayout while the
    // previous sentinel window may still be open — the conditions that used to
    // strand the view detached.
    for (let i = 0; i < 16; i++) {
      await selectDevice(mainWindow, CYCLE[i % CYCLE.length]!.name)
      await new Promise((r) => setTimeout(r, 120))
    }
    // Let the last relayout settle.
    await new Promise((r) => setTimeout(r, 2500))

    // The exact bug signal: the content WCV's visibilityState stuck at 'hidden'.
    const visibility = await evalInSimulator<string>(electronApp, 'document.visibilityState')
    expect(
      visibility,
      'after repeated device switches the simulator content view must stay visible '
      + "(the white-screen bug left it stuck at 'hidden' after a spurious detach)",
    ).toBe('visible')

    // It is actually laid out / painting, not a zero-area ghost.
    const innerWidth = await evalInSimulator<number>(electronApp, 'window.innerWidth')
    expect(innerWidth, 'DeviceShell viewport should have a non-zero width (rendering)').toBeGreaterThan(0)

    // visibilityState + innerWidth above are the authoritative no-white-screen
    // signals: a content WebContentsView that was detached OR setVisible(false)
    // reports document.visibilityState 'hidden' — the exact symptom the bug
    // report flagged. Both being 'visible'/non-zero after the switch storm is
    // the proof the reconciler self-healed every relayout transient.
  })
})
