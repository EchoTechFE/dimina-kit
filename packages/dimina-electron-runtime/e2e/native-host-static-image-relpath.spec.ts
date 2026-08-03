/**
 * E2E (native-host only): local package image paths must resolve against the
 * `dmb-resource://` render-host document, not the old `file://…/pageFrame.html`
 * asar URL — and must land on the package's own `<appId>/<root>/…` path, not
 * just anywhere on the dmb-resource origin.
 *
 * Guards the downstream report where `<image src="../../static/avatars/…">`
 * resolved into the developer-tools install directory and failed with
 * naturalWidth 0. Fixing that revealed a second bug: the render host used to
 * navigate a *fixed* `dmb-resource://<bridgeId>/__sdk__/render-host/pageFrame.html`
 * for every page, so a relative reference always resolved relative to that
 * fixed SDK path, never to the page's real location in the package (it landed
 * one level too shallow, missing the `<appId>/<root>/` prefix). The render
 * host now navigates `dmb-resource://<bridgeId>/<appId>/<root>/<page
 * directory>/__frame__.html` — directly under the page's own package path,
 * no separate virtual prefix, with `__frame__.html` (a reserved name that
 * can't collide with a real compiled package file) marking it as the
 * document rather than a package resource — so the document's own directory
 * depth tracks the page's directory depth inside the package, and a
 * hand-written relative reference resolves, via the browser's own WHATWG
 * algorithm, to the correct package path.
 *
 * Self-launches its own native-host electron.
 */
import { test, expect, _electron, type ElectronApplication, type Page as PwPage } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import {
  openProject,
  waitForSimulatorWebview,
  closeProject,
  pollUntil,
  evalInSimulator,
  RENDER_GUEST_URL_MARKER,
} from './helpers'

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

// The render-host document is served at a URL containing `__frame__.html`
// (RENDER_GUEST_URL_MARKER), not the old fixed `pageFrame.html` SDK path (see
// the file header). The marker is passed through `electronApp.evaluate`'s
// payload rather than hardcoded inside the closure: that closure is
// serialized and run in Electron's main process, so it can't close over this
// file's imported constant — it only sees whatever comes through as a normal
// argument.
async function evalInActivePageFrame<T>(expression: string): Promise<T> {
  return electronApp.evaluate(async ({ webContents }, payload) => {
    const pages = webContents.getAllWebContents().filter((wc) =>
      !wc.isDestroyed() && wc.getURL().includes(payload.marker),
    )
    const target = pages[pages.length - 1]
    if (!target) throw new Error(`No ${payload.marker} render-host guest`)
    if (target.isLoading()) throw new Error('pageFrame guest is still loading')
    return target.executeJavaScript(payload.expr)
  }, { marker: RENDER_GUEST_URL_MARKER, expr: expression }) as Promise<T>
}

async function readProbe(): Promise<ProbeResult | null> {
  // Plain template-literal interpolation, not a serialized closure — this
  // string is built here in the test process, then shipped as inert text for
  // `executeJavaScript` to run inside the guest, so importing the constant
  // works normally (unlike the `electronApp.evaluate` closure above).
  return evalInActivePageFrame<ProbeResult | null>(`(() => {
    if (!location.href.includes('${RENDER_GUEST_URL_MARKER}')) return null
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
        ?? path.resolve(__dirname, '..', 'node_modules', '.cache', 'electron-runtime-e2e'),
      'userdata',
      `nh-static-img-${process.pid}`,
    )
    fs.mkdirSync(userDataDir, { recursive: true })

    electronApp = await _electron.launch({
      args: [appPath, `--user-data-dir=${userDataDir}`],
      env: {
        ...process.env,
        NODE_ENV: 'test',
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

    await openProject(electronApp, FIXTURE_APP)
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
    await closeProject(electronApp).catch(() => {})
    await electronApp?.close().catch(() => {})
  })

  // These document-URL assertions pin the CURRENT render-host document path
  // convention: it encodes `<appId>/<root>/<page directory>` directly (no
  // separate virtual prefix) so its own directory depth tracks the page's
  // package directory depth (see the file header). Fixture appId is
  // `staticimagerelpath`, default root `main` (see
  // `fixtures/static-image-relpath-app/project.config.json`).
  //
  // The `relativeResolved` assertion checks the FULL package-relative path,
  // not just the tail (`/static/avatars/probe.png$`) — a form missing the
  // `staticimagerelpath/main/` prefix entirely would also match the tail-only
  // check, which is exactly the bug this test guards against.
  test('render-host document is dmb-resource under <appId>/<root>/… and local images load', async () => {
    const ready = await pollUntil(
      () => readProbe(),
      (p) => !!p
        && p.documentUrl.includes(RENDER_GUEST_URL_MARKER)
        && p.documentUrl.startsWith('dmb-resource://'),
      30000,
      400,
    )
    expect(ready, 'pageFrame guest should navigate on dmb-resource://').not.toBeNull()
    expect(ready!.documentUrl).toContain('/staticimagerelpath/main/')
    expect(ready!.documentUrl).toMatch(/\/__frame__\.html(\?|$)/)
    expect(ready!.documentUrl.startsWith('file:')).toBe(false)

    // The relative reference now resolves with the appId/root prefix intact
    // (the reported failure mode was file:///…/app.asar/…/devtools/static/…,
    // and the intermediate, still-buggy form was a dmb-resource:// URL that
    // dropped the appId/root prefix entirely).
    expect(ready!.relativeResolved.startsWith('dmb-resource://')).toBe(true)
    expect(ready!.relativeResolved).toMatch(/\/staticimagerelpath\/main\/static\/avatars\/probe\.png$/)
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
      // The prior checks above would pass even for the old buggy
      // `dmb-resource://.../static/avatars/...` form (missing the appId/root
      // prefix) as long as it happened to decode — assert the real package
      // path landed, not just "somewhere non-file/asar".
      expect(
        img.currentSrc.includes('/staticimagerelpath/main/'),
        `currentSrc must land under staticimagerelpath/main/ (got ${img.currentSrc})`,
      ).toBe(true)
    }
  })
})
