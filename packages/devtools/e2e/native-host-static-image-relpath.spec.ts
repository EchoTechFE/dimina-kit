/**
 * E2E (native-host only): local package image paths must resolve against the
 * `dmb-resource://` render-host document, not the old `file://…/pageFrame.html`
 * asar URL.
 *
 * Guards the downstream report where `<image src="../../static/avatars/…">`
 * resolved into the developer-tools install directory and failed with
 * naturalWidth 0. The render host now navigates
 * `dmb-resource://<bridgeId>/__sdk__/render-host/pageFrame.html` (WeChat
 * `/__pageframe__/` / Android `/jssdk/` shape) so relative and root-absolute
 * package paths stay on the package resource origin.
 *
 * Self-launches its own native-host electron — do not set
 * `process.env.DIMINA_NATIVE_HOST` at module scope (poisons --workers=1).
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

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_APP = path.resolve(__dirname, 'fixtures', 'static-image-relpath-app')

let electronApp: ElectronApplication
let mainWindow: PwPage

interface ProbeResult {
  documentUrl: string
  relativeResolved: string
  absoluteResolved: string
  images: Array<{
    src: string
    currentSrc: string
    naturalWidth: number
    complete: boolean
  }>
}

async function evalInActivePageFrame<T>(expression: string): Promise<T> {
  return electronApp.evaluate(async ({ webContents }, expr) => {
    const pages = webContents.getAllWebContents().filter((wc) =>
      !wc.isDestroyed() && wc.getURL().includes('pageFrame.html'),
    )
    const target = pages[pages.length - 1]
    if (!target) throw new Error('No pageFrame.html render-host guest')
    if (target.isLoading()) throw new Error('pageFrame guest is still loading')
    return target.executeJavaScript(expr)
  }, expression) as Promise<T>
}

async function readProbe(): Promise<ProbeResult | null> {
  return evalInActivePageFrame<ProbeResult | null>(`(() => {
    if (!location.href.includes('pageFrame.html')) return null
    const relativeResolved = new URL('../../static/avatars/probe.png', location.href).href
    const absoluteResolved = new URL('/staticimagerelpath/main/static/probe.png', location.href).href
    const images = [...document.querySelectorAll('img')].map((img) => ({
      src: img.getAttribute('src') || img.src || '',
      currentSrc: img.currentSrc || '',
      naturalWidth: img.naturalWidth || 0,
      complete: !!img.complete,
    }))
    return {
      documentUrl: location.href,
      relativeResolved,
      absoluteResolved,
      images,
    }
  })()`).catch(() => null)
}

test.describe('native-host local static image path resolution', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(180_000)

  test.beforeAll(async () => {
    const appPath = path.resolve(__dirname, 'electron-entry.js')
    const userDataDir = path.resolve(
      process.env.DIMINA_DEVTOOLS_DATA_DIR
        ?? path.resolve(__dirname, '..', 'node_modules', '.cache', 'devtools-e2e'),
      'userdata',
      `nh-static-img-${process.pid}`,
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

    await openProjectInUI(mainWindow, FIXTURE_APP, { waitMs: 25000 })
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

  test('render-host document is dmb-resource under /__sdk__/ and local images load', async () => {
    const ready = await pollUntil(
      () => readProbe(),
      (p) => !!p
        && p.documentUrl.includes('pageFrame.html')
        && p.documentUrl.startsWith('dmb-resource://'),
      30000,
      400,
    )
    expect(ready, 'pageFrame guest should navigate on dmb-resource://').not.toBeNull()
    expect(ready!.documentUrl).toContain('/__sdk__/render-host/pageFrame.html')
    expect(ready!.documentUrl.startsWith('file:')).toBe(false)

    // Browser-relative package paths climb out of /__sdk__/render-host/ to the
    // package root on the same dmb-resource origin (the reported failure mode
    // was file:///…/app.asar/…/devtools/static/…).
    expect(ready!.relativeResolved.startsWith('dmb-resource://')).toBe(true)
    expect(ready!.relativeResolved).toMatch(/\/static\/avatars\/probe\.png$/)
    expect(ready!.relativeResolved.startsWith('file:')).toBe(false)
    expect(ready!.absoluteResolved.startsWith('dmb-resource://')).toBe(true)

    let last: ProbeResult | null = ready
    const probe = await pollUntil(
      async () => {
        last = await readProbe()
        return last
      },
      (p) => !!p && p.images.some((img) => img.naturalWidth > 0),
      30000,
      400,
    ).catch((err) => {
      throw new Error(`${String(err)}\nlast probe: ${JSON.stringify(last, null, 2)}`)
    })

    // pollUntil returns the final attempt even when the predicate never holds.
    if (!probe!.images.some((img) => img.naturalWidth > 0)) {
      throw new Error(`img never decoded; last probe: ${JSON.stringify(probe, null, 2)}`)
    }

    const loaded = probe!.images.filter((img) => img.naturalWidth > 0)
    expect(loaded.length, 'at least one <img> must decode (naturalWidth > 0)').toBeGreaterThan(0)
    for (const img of loaded) {
      expect(
        img.currentSrc.startsWith('dmb-resource://') || img.currentSrc.startsWith('http'),
        `loaded image currentSrc must not be file/asar (got ${img.currentSrc})`,
      ).toBe(true)
      expect(img.currentSrc.startsWith('file:'), `currentSrc must not be file: (${img.currentSrc})`).toBe(false)
      expect(img.currentSrc.includes('app.asar'), `currentSrc must not land in app.asar (${img.currentSrc})`).toBe(false)
    }
  })
})
