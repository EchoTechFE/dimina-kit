/**
 * E2E (native-host only): ProjectChannel.CaptureThumbnail captures the
 * render guest (pageFrame.html) content, not the outer simulator
 * WebContentsView (DeviceShell chrome).
 *
 * Under native-host the simulator panel WebContentsView (simulator.html)
 * hosts the DeviceShell HTML — phone bezels, gray "desk" background and the
 * phone chrome. The actual mini-app content lives in a SEPARATE WebContents
 * (`pageFrame.html`) hosted as a nested <webview> inside the DeviceShell.
 *
 * The discriminating observable is image pixel dimensions:
 *   - The outer simulator WVC captures the full DeviceShell page, which
 *     includes the desk padding and phone chrome around the screen. Its
 *     PNG is LARGER in at least one dimension.
 *   - The render guest captures only the phone screen content area (no
 *     chrome, no desk). Its PNG is smaller — sized to the screen rectangle.
 *
 * captureThumbnail must return a PNG whose pixel dimensions match the render
 * guest, NOT the outer simulator WVC. Capturing the outer WVC would include
 * phone bezels and the gray desk background, which are visually wrong for a
 * project thumbnail.
 *
 * Sizes are measured by parsing the PNG IHDR chunk (bytes 16–23) both in
 * the main process (for the two live WebContents) and in the test runner
 * (for the returned data URL). This keeps the unit consistent: actual device
 * pixels, independent of CSS DPR scaling.
 *
 * captureThumbnail targets the render guest; its PNG dimensions must equal
 * the guest's screen area (smaller). Targeting the outer WVC produces a PNG
 * matching the WVC dimensions (larger) and the size assertions below fail.
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
} from './helpers'
import { ProjectChannel, AutomationChannel } from '../src/shared/ipc-channels'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = path.resolve(__dirname, 'fixtures', 'tabbar-app')

/**
 * Parse the pixel dimensions from a PNG data URL by reading the IHDR chunk.
 * PNG layout: 8-byte signature, then chunks. The first chunk is always IHDR:
 *   bytes  8–11: chunk length (4 bytes)
 *   bytes 12–15: "IHDR"
 *   bytes 16–19: width  (big-endian uint32)
 *   bytes 20–23: height (big-endian uint32)
 */
function parsePngSize(dataUrl: string): { width: number; height: number } | null {
  const prefix = 'data:image/png;base64,'
  if (!dataUrl.startsWith(prefix)) return null
  const buf = Buffer.from(dataUrl.slice(prefix.length), 'base64')
  if (buf.length < 24) return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

test.describe('native-host captureThumbnail targets the render guest, not the simulator WVC', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(180_000)

  let electronApp: ElectronApplication
  let mainWindow: PwPage

  test.beforeAll(async () => {
    // Extend the hook timeout: Electron cold-boot + first fixture compile can
    // exceed the 60s config default. Setting it INSIDE the hook overrides the
    // hook's own budget (the describe-level setTimeout only covers tests).
    test.setTimeout(180_000)
    const appPath = path.resolve(__dirname, 'electron-entry.js')
    const userDataDir = path.resolve(
      process.env.DIMINA_DEVTOOLS_DATA_DIR
        ?? path.resolve(__dirname, '..', 'node_modules', '.cache', 'devtools-e2e'),
      'userdata',
      `nh-thumb-capture-${process.pid}`,
    )
    fs.mkdirSync(userDataDir, { recursive: true })

    electronApp = await _electron.launch({
      args: [appPath, 'auto', '--auto-port', '0', `--user-data-dir=${userDataDir}`],
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DIMINA_NATIVE_HOST: '1',
        DIMINA_E2E_USER_DATA_DIR: userDataDir,
      },
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

    // Wait until the render guest (pageFrame.html) is mounted and has a URL —
    // captureThumbnail falls back to the outer WVC when the guest is absent,
    // so the test must call it only after the guest is live.
    await pollUntil(
      () => electronApp.evaluate(({ webContents }) =>
        webContents.getAllWebContents().some(
          (wc) => !wc.isDestroyed() && wc.getURL().includes('pageFrame.html'),
        ),
      ),
      (present) => present === true,
      30000,
      300,
    )
  })

  test.afterAll(async () => {
    await closeProject(mainWindow).catch(() => {})
    await electronApp?.close().catch(() => {})
  })

  test('thumbnail PNG dimensions match the render guest, not the outer simulator WVC', async () => {
    // Measure the pixel dimensions of the outer simulator WVC (simulator.html)
    // and the render guest (pageFrame.html) via PNG header in the main process.
    // Both captures happen before the IPC call so the timing is deterministic.
    const wcSizes = await electronApp.evaluate(async ({ webContents }) => {
      const all = webContents.getAllWebContents()
      const simWc = all.find(
        (wc) => wc.getURL().includes('simulator.html') && !wc.isDestroyed(),
      )
      const guestWc = all.find(
        (wc) => wc.getURL().includes('pageFrame.html') && !wc.isDestroyed(),
      )
      if (!simWc || !guestWc) return null

      const [simImg, guestImg] = await Promise.all([
        simWc.capturePage(),
        guestWc.capturePage(),
      ])

      const simPng = simImg.toPNG()
      const guestPng = guestImg.toPNG()

      // PNG IHDR: bytes 16–19 = width (big-endian), 20–23 = height (big-endian).
      return {
        sim: {
          width: simPng.readUInt32BE(16),
          height: simPng.readUInt32BE(20),
        },
        guest: {
          width: guestPng.readUInt32BE(16),
          height: guestPng.readUInt32BE(20),
        },
      }
    })

    expect(wcSizes, 'both simulator WVC and render guest must be capturable').toBeTruthy()

    // Guard: the test can only discriminate by size when the outer WVC is
    // strictly larger than the guest. The outer WVC includes the desk
    // background and phone bezels, so its PNG must be wider or taller than
    // the guest screen rectangle.
    // If this precondition fails the environment is unusual; the size
    // comparison below would be inconclusive. Fail fast with a clear message.
    const simIsLarger =
      wcSizes!.sim.width > wcSizes!.guest.width ||
      wcSizes!.sim.height > wcSizes!.guest.height
    expect(
      simIsLarger,
      `outer simulator WVC (${wcSizes!.sim.width}×${wcSizes!.sim.height}) must be larger ` +
      `than render guest (${wcSizes!.guest.width}×${wcSizes!.guest.height}). ` +
      `If they are the same size the desk/chrome padding is absent and the size discriminator cannot be used.`,
    ).toBe(true)

    // Call captureThumbnail via IPC (the renderer-facing entry point).
    const thumbnailDataUrl = await ipcInvoke<string | null>(
      mainWindow,
      ProjectChannel.CaptureThumbnail,
      FIXTURE_DIR,
    )
    expect(thumbnailDataUrl, 'captureThumbnail must return a non-null data URL').toBeTruthy()

    const thumbSize = parsePngSize(thumbnailDataUrl!)
    expect(thumbSize, 'returned data URL must be a valid PNG').toBeTruthy()

    // Core contract: the thumbnail's pixel dimensions must match the render
    // guest, NOT the outer simulator WVC.
    //
    // captureThumbnail targets getActiveRenderWc() (the render guest), so
    // its PNG dimensions equal the guest screen area only — no phone bezels,
    // no gray desk background. A regression that uses the outer simulatorWc
    // instead produces a PNG matching wcSizes.sim (the larger outer WVC);
    // this assertion catches that regression.
    expect(
      thumbSize!.width,
      `thumbnail width ${thumbSize!.width} must match render guest width ${wcSizes!.guest.width}, ` +
      `not outer simulator WVC width ${wcSizes!.sim.width}`,
    ).toBe(wcSizes!.guest.width)

    expect(
      thumbSize!.height,
      `thumbnail height ${thumbSize!.height} must match render guest height ${wcSizes!.guest.height}, ` +
      `not outer simulator WVC height ${wcSizes!.sim.height}`,
    ).toBe(wcSizes!.guest.height)
  })
})
