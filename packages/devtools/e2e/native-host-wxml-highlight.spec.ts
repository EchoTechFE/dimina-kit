/**
 * E2E: the WXML panel's hover highlight is drawn by the native CDP
 * `Overlay.highlightNode` over the render guest's debugger session — NOT by an
 * injected `<div>` overlay in the guest.
 *
 * Three discriminating facts, asserted against the REAL render-host guest under
 * DIMINA_NATIVE_HOST=1 (a top-level WebContentsView hosting per-page
 * `pageFrame.html` <webview>s):
 *
 *  1. Negative — the render-host inspector IIFE owns the guest realm
 *     (`window.__diminaRenderInspect` is present) AND no `#__simulator-highlight`
 *     div is ever created in the guest by a highlight. The div lives only in the
 *     iframe/dimina-fe `bridge.ts` path, which native-host doesn't use; if the
 *     guest grew one, the old div path would have regressed back in.
 *  2. Positive — a hover paints a native overlay the guest's own `capturePage()`
 *     captures: a large block of new pixels (the translucent content fill) plus
 *     the `showInfo` size tooltip. Asserted loosely (changed-pixel count over a
 *     threshold) so palette/position shifts don't make it brittle.
 *  3. No-Elements-interaction — on a FRESH electron instance, with the Chrome
 *     Elements panel never opened by the user, the FIRST WXML hover must still
 *     paint the native overlay. The Overlay domain is enabled end-to-end by
 *     whichever path gets there first: elements-forward (production-always-on for
 *     the native simulator, primes the active guest on devtools onReady — see
 *     elements-forward/index.ts primeGuest) OR render-inspect's own
 *     `DOM.enable → Overlay.enable` handshake. This asserts the end-to-end paint
 *     without the user ever touching Elements; it does NOT isolate render-inspect's
 *     handshake (elements-forward backs it in this path, so e2e can't make the
 *     handshake the sole Overlay-enable source). render-inspect's cold-session
 *     `DOM`-before-`Overlay` ordering is guarded deterministically by the unit
 *     test in render-inspect/index.test.ts instead.
 *
 * The negative assertion runs against the GUEST (pageFrame.html) document, never
 * the simulator iframe — the iframe path's `#__simulator-highlight` is alive and
 * irrelevant here.
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
  evalInWebContentsByUrl,
} from './helpers'
import {
  AutomationChannel,
  SimulatorElementChannel,
  SimulatorWxmlChannel,
} from '../src/shared/ipc-channels'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = path.resolve(__dirname, 'fixtures', 'tabbar-app')

interface WxmlNode { tagName?: string; sid?: string; children?: WxmlNode[] }

interface AppHandle { app: ElectronApplication; win: PwPage }

/**
 * Launch a fresh, isolated native-host devtools instance with the fixture open,
 * waiting until the render guest's WXML tree is mounted. Each describe gets its
 * own handle so the cold-start guest is genuinely cold (its per-wc Overlay enable
 * has never been triggered by a prior hover).
 */
async function bootApp(slot: string): Promise<AppHandle> {
  const appPath = path.resolve(__dirname, 'electron-entry.js')
  const userDataDir = path.resolve(
    process.env.DIMINA_DEVTOOLS_DATA_DIR
      ?? path.resolve(__dirname, '..', 'node_modules', '.cache', 'devtools-e2e'),
    'userdata',
    `nh-wxml-highlight-${slot}-${process.pid}`,
  )
  fs.mkdirSync(userDataDir, { recursive: true })

  const app = await _electron.launch({
    args: [appPath, 'auto', '--auto-port', '0', `--user-data-dir=${userDataDir}`],
    env: { ...process.env, NODE_ENV: 'test', DIMINA_NATIVE_HOST: '1', DIMINA_E2E_USER_DATA_DIR: userDataDir },
  })

  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  await app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    if (w && !w.isVisible()) {
      await new Promise<void>((resolve) => {
        w.once('show', resolve)
        setTimeout(resolve, 5000)
      })
    }
    if (w) {
      w.setPosition(-2000, -2000)
      w.blur()
    }
  })

  await pollUntil(
    () => ipcInvoke<number | null>(win, AutomationChannel.GetPort),
    (val) => typeof val === 'number' && val > 0,
    10000,
    100,
  )

  await openProjectInUI(win, FIXTURE_DIR, { waitMs: 20000 })
  await waitForSimulatorWebview(app)

  // The WXML snapshot is the readiness signal the panel itself uses; it injects
  // the inspector IIFE via executeJavaScript and does NOT touch CDP/Overlay, so
  // the guest's Overlay domain stays cold until the first Inspect.
  await pollUntil(
    () => ipcInvoke<WxmlNode | null>(win, SimulatorWxmlChannel.GetSnapshot).catch(() => null),
    (t) => !!t && typeof t.tagName === 'string',
    30000,
    400,
  )

  return { app, win }
}

async function shutdownApp(handle: AppHandle | undefined): Promise<void> {
  if (!handle) return
  await closeProject(handle.win).catch(() => {})
  await handle.app.close().catch(() => {})
}

/** Collect every sid in the WXML tree, parents before children. */
function collectSids(node: WxmlNode | null | undefined, out: string[]): void {
  if (!node) return
  if (typeof node.sid === 'string' && node.sid) out.push(node.sid)
  for (const c of node.children ?? []) collectSids(c, out)
}

/** Probe the live render guest (pageFrame.html) main world. */
function evalInGuest<T>(app: ElectronApplication, expression: string): Promise<T | null> {
  return evalInWebContentsByUrl<T>(app, 'pageFrame.html', expression).catch(() => null)
}

/** Count live render-guest webContents (pageFrame.html). */
function guestCount(app: ElectronApplication): Promise<number> {
  return app.evaluate(({ webContents }) =>
    webContents.getAllWebContents().filter((wc) => wc.getURL().includes('pageFrame.html') && !wc.isDestroyed()).length,
  )
}

/**
 * Capture the render guest's bitmap in the MAIN process and compare it against a
 * baseline (also a main-process capture), returning the count of pixels whose
 * BGRA channels differ beyond `tol` and a coarse blue-fill tally. capturePage()
 * runs on the guest WebContents directly, so it sees the native Overlay the
 * compositor paints over the page (Playwright page screenshots can't reach
 * nested webview content; a direct WebContents capture can).
 *
 * The guest selection (`pageFrame.html`) must be the SAME one the Inspect hover
 * targets; callers guard that by asserting a single live guest before measuring.
 */
async function captureGuestStats(app: ElectronApplication, baselineB64: string | null, tol = 24): Promise<{
  b64: string
  changed: number
  bluish: number
  total: number
} | null> {
  return app.evaluate(async ({ webContents }, payload) => {
    const guest = webContents
      .getAllWebContents()
      .find((wc) => wc.getURL().includes('pageFrame.html') && !wc.isDestroyed())
    if (!guest) return null
    const img = await guest.capturePage()
    const buf = img.toBitmap() // BGRA, row-major
    const b64 = buf.toString('base64')
    const total = buf.length / 4
    let bluish = 0
    // The native content fill is a translucent blue (contentColor ~ rgb(111,168,220)):
    // blue channel meaningfully above red, with real saturation. A plain page that
    // is incidentally blue-ish won't shift this count between two captures.
    for (let i = 0; i < buf.length; i += 4) {
      const b = buf[i], g = buf[i + 1], r = buf[i + 2]
      if (b > r + 25 && b > g + 5 && b > 90) bluish++
    }
    let changed = 0
    if (payload.baselineB64) {
      const base = Buffer.from(payload.baselineB64, 'base64')
      const n = Math.min(base.length, buf.length)
      for (let i = 0; i < n; i += 4) {
        if (
          Math.abs(base[i] - buf[i]) > payload.tol ||
          Math.abs(base[i + 1] - buf[i + 1]) > payload.tol ||
          Math.abs(base[i + 2] - buf[i + 2]) > payload.tol
        ) changed++
      }
    }
    return { b64, changed, bluish, total }
  }, { baselineB64, tol })
}

/** Walk the WXML tree (once it's up) and return its sids in tree order. */
async function getGuestSids(win: PwPage): Promise<string[]> {
  const tree = await pollUntil(
    () => ipcInvoke<WxmlNode | null>(win, SimulatorWxmlChannel.GetSnapshot).catch(() => null),
    (t) => !!t && typeof t.tagName === 'string',
    30000,
    400,
  )
  const sids: string[] = []
  collectSids(tree as WxmlNode, sids)
  return sids
}

/**
 * Inspect sids in order until one paints a real overlay: the IPC returns a rect
 * AND the guest capture gains a big block of new bluish pixels over the
 * pre-hover baseline. Returns the winning sid + stats, or null if none paint.
 */
async function hoverUntilPainted(
  handle: AppHandle,
  sids: string[],
  baseline: { b64: string; bluish: number },
): Promise<{ sid: string; changed: number; bluishDelta: number } | null> {
  const { app, win } = handle
  for (const sid of sids.slice(0, 30)) {
    const r = await ipcInvoke<{ rect?: { width?: number } } | null>(
      win, SimulatorElementChannel.Inspect, sid,
    ).catch(() => null)
    if (!r || !r.rect) continue
    // Let the compositor paint the overlay before capturing.
    await win.waitForTimeout(300)
    const after = await captureGuestStats(app, baseline.b64)
    if (!after) continue
    const bluishDelta = after.bluish - baseline.bluish
    // A painted overlay covers a sizable element: many changed pixels and a real
    // gain in translucent-blue coverage. Thresholds are loose but well clear of
    // capture noise (sub-pixel AA jitter is a few hundred pixels at most).
    if (after.changed > 4000 && bluishDelta > 1500) {
      return { sid, changed: after.changed, bluishDelta }
    }
    await ipcInvoke(win, SimulatorElementChannel.Clear).catch(() => {})
    await win.waitForTimeout(150)
  }
  return null
}

test.describe('native-host WXML highlight via CDP Overlay (not a div)', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(180_000)

  let handle: AppHandle

  test.beforeAll(async () => {
    handle = await bootApp('warm')
  })

  test.afterAll(async () => {
    await shutdownApp(handle)
  })

  test('the render-host inspector IIFE owns the guest realm (not the iframe div path)', async () => {
    // Reading the WXML tree injects the IIFE; afterwards the guest must expose
    // __diminaRenderInspect, proving highlight resolves sids against the
    // render-host registry, not the dimina-fe iframe's __simulatorData.
    await ipcInvoke(handle.win, SimulatorWxmlChannel.GetSnapshot).catch(() => null)
    const hasApi = await pollUntil(
      () => evalInGuest<boolean>(handle.app, '!!(window.__diminaRenderInspect && typeof window.__diminaRenderInspect.elementFor === "function")'),
      (ok) => ok === true,
      15000,
      300,
    )
    expect(hasApi, 'render guest should expose window.__diminaRenderInspect.elementFor').toBe(true)
  })

  test('hovering paints a native overlay and creates NO #__simulator-highlight div in the guest', async () => {
    // Single live guest so the capture targets the SAME page the Inspect hovers.
    expect(await guestCount(handle.app), 'fixture should have exactly one live render guest').toBe(1)

    const sids = await getGuestSids(handle.win)
    expect(sids.length, 'WXML tree should expose sids to hover').toBeGreaterThan(0)

    // Pre-hover baseline of the guest pixels + the div-absent invariant.
    const before = await captureGuestStats(handle.app, null)
    expect(before, 'guest capturePage should return a bitmap').toBeTruthy()

    const painted = await hoverUntilPainted(handle, sids, { b64: before!.b64, bluish: before!.bluish })
    expect(
      painted,
      'at least one hovered sid should paint a native Overlay (large changed-pixel + blue-fill gain) the guest capture sees',
    ).toBeTruthy()

    // Negative: the IIFE highlight path must never inject the legacy div overlay.
    // This is the div whose absence proves the old guest-div path is gone.
    const divInGuest = await evalInGuest<boolean>(
      handle.app, "!!document.getElementById('__simulator-highlight')",
    )
    expect(
      divInGuest,
      'render guest must NOT contain #__simulator-highlight (the old injected-div overlay path)',
    ).toBe(false)

    await ipcInvoke(handle.win, SimulatorElementChannel.Clear).catch(() => {})
  })
})

test.describe('native-host WXML highlight without opening the Elements panel', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(180_000)

  let handle: AppHandle

  test.beforeAll(async () => {
    // A FRESH instance whose Elements panel the user never opens. bootApp only
    // ever calls GetSnapshot (IIFE inject, no CDP), so this test path never drives
    // the embedded Elements panel; the only things that enable the guest's Overlay
    // domain are elements-forward's onReady prime and render-inspect's handshake.
    handle = await bootApp('no-elements')
  })

  test.afterAll(async () => {
    await shutdownApp(handle)
  })

  test('the FIRST WXML hover paints the native overlay with the Elements panel untouched', async () => {
    // The first Inspect drives the native draw end-to-end without the user ever
    // opening Elements. Overlay ends up enabled by whichever path arrives first
    // (elements-forward prime or render-inspect's own enable); this asserts the
    // paint happens, not which path enabled it.
    expect(await guestCount(handle.app), 'fixture should have exactly one live render guest').toBe(1)

    const sids = await getGuestSids(handle.win)
    expect(sids.length, 'WXML tree should expose sids').toBeGreaterThan(0)

    const before = await captureGuestStats(handle.app, null)
    expect(before, 'guest capturePage should return a bitmap').toBeTruthy()

    const painted = await hoverUntilPainted(handle, sids, { b64: before!.b64, bluish: before!.bluish })
    expect(
      painted,
      'the first WXML hover must paint the native overlay even with the Elements panel never opened',
    ).toBeTruthy()

    const divInGuest = await evalInGuest<boolean>(
      handle.app, "!!document.getElementById('__simulator-highlight')",
    )
    expect(divInGuest, 'hover must not fall back to a guest div overlay').toBe(false)

    await ipcInvoke(handle.win, SimulatorElementChannel.Clear).catch(() => {})
  })
})
