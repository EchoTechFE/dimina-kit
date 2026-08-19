/**
 * E2E (native-host only): page-stack orientation resolution across route entries other than plain navigateTo/navigateBack(1) (already covered by native-host-orientation-config.spec.ts), device rotation while a fixed-orientation page is on screen, and rapid re-entrant navigation.
 *
 * Contract pinned here (see shared/page-orientation.ts and DeviceShell's OrientationController, which is the single authority every route entry funnels through):
 *
 *   1. Each page keeps its OWN `PageOrientationState` for as long as it stays
 * mounted (visible or cached under a hidden stack entry).
 * Backgrounding a page never touches its state; bringing it back to the foreground — through navigateBack at ANY delta, redirectTo, or reLaunch — recomputes its effective orientation fresh from that page's own config, never from whatever page was in between.
 *   2. `redirectTo`/`reLaunch` replace page-stack entries outright: the
 * pages they discard are gone, along with any orientation they were showing — there is nothing left to "restore" back to.
 *   3. An 'auto' page's effective orientation is a live function of the
 * CURRENT device orientation, recomputed on every visit — including a re-visit via navigateBack past a fixed-orientation page that forced a different orientation while it was on top. "Restore what a page showed on the way in" is a fixed-orientation-only illusion; an 'auto' page never has a fixed value to restore to.
 *   4. Back-to-back route calls (navigateTo immediately followed by
 * navigateBack, issued before the entered page's own orientation/ geometry round trip necessarily lands — see the last test's own doc comment for what that leaves in flight) must still leave the page stack and the displayed orientation in a consistent end state — not stuck on whichever page's geometry happened to be mid-transition.
 *
 * Fixture: e2e/fixtures/orientation-app-landscape — app.json's window is 'landscape'. pages/entry (root, inherits landscape), pages/autopage ('auto', follows the device), pages/portraitpage ('portrait', fixed), pages/mid (no page-level config, inherits landscape same as entry — used as the middle layer of a three-deep stack so a page under app-level inheritance, not just an explicit config, is also exercised mid-stack).
 *
 * Driving mechanism: `__diminaE2eHooks.rotateDevice()`, not `setDevice()` — see native-host-orientation-config.spec.ts's module doc comment.
 * Geometry is read from the SERVICE host's own `wx.getSystemInfoSync()`, the authoritative channel the mini-app's own code observes.
 */
import { test, expect, useSharedProject } from './fixtures'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  pollUntil,
  callWxMethod,
  getCurrentPage,
  getPageStack,
  waitForServicePageReady,
} from './helpers'
import type { ElectronApplication } from '@playwright/test'
import type { NativeDeviceInfo } from '@dimina-kit/electron-runtime'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = path.resolve(__dirname, 'fixtures', 'orientation-app-landscape')
const APP_ID = 'devtools_orientation_app_landscape_fixture' // fixtures/orientation-app-landscape/project.config.json appid

const ENTRY_ROUTE = 'pages/entry/entry'
const AUTO_ROUTE = 'pages/autopage/autopage'
const PORTRAIT_ROUTE = 'pages/portraitpage/portraitpage'
const MID_ROUTE = 'pages/mid/mid'

// ── Device rotation (see the module doc comment) ──────────────────────

function device(orientation: 'portrait' | 'landscape'): NativeDeviceInfo {
  return {
    brand: 'Apple',
    model: 'iPhone 14 Pro',
    system: 'iOS 16.3',
    platform: 'ios',
    pixelRatio: 3,
    screenWidth: 393,
    screenHeight: 852,
    statusBarHeight: 54,
    notchType: 'dynamic-island',
    safeAreaInsets: { top: 54, right: 0, bottom: 34, left: 0 },
    deviceOrientation: orientation,
  }
}

async function rotateDevice(app: ElectronApplication, orientation: 'portrait' | 'landscape'): Promise<void> {
  await app.evaluate((_electron, d) => {
    const hooks = (globalThis as Record<string, unknown>).__diminaE2eHooks as { rotateDevice: (device: unknown) => void }
    hooks.rotateDevice(d)
  }, device(orientation))
}

// ── Geometry (service-host wx.getSystemInfoSync()) ────────────────────

interface ReportedInfo {
  windowWidth?: number
  windowHeight?: number
}

async function readServiceSystemInfo(app: ElectronApplication): Promise<ReportedInfo> {
  return pollUntil<ReportedInfo>(
    () => app.evaluate(async ({ webContents }) => {
      const svc = webContents.getAllWebContents().find(
        (wc) => !wc.isDestroyed() && wc.getURL().includes('/service-host/service.html'),
      )
      if (!svc) throw new Error('service.html not found')
      return svc.executeJavaScript(`(() => {
        const w = globalThis.wx
        if (!w || typeof w.getSystemInfoSync !== 'function') throw new Error('wx.getSystemInfoSync missing')
        const i = w.getSystemInfoSync()
        return { windowWidth: i.windowWidth, windowHeight: i.windowHeight }
      })()`)
    }).catch(() => ({}) as ReportedInfo),
    (info) =>
      typeof info.windowWidth === 'number' && Number.isFinite(info.windowWidth)
      && typeof info.windowHeight === 'number' && Number.isFinite(info.windowHeight),
    20_000,
    400,
  )
}

/** Poll until the reported viewport matches `expected` — orientation changes
 * are asynchronous, so a single snapshot right after a triggering action can race a not-yet-landed update. */
async function waitForOrientation(app: ElectronApplication, expected: 'portrait' | 'landscape'): Promise<ReportedInfo> {
  return pollUntil<ReportedInfo>(
    () => readServiceSystemInfo(app),
    (info) => {
      const w = info.windowWidth ?? -1
      const h = info.windowHeight ?? -1
      return expected === 'landscape' ? w > h : w < h
    },
    15_000,
    400,
  )
}

async function waitForRoute(app: ElectronApplication, route: string): Promise<void> {
  await pollUntil(
    () => getCurrentPage(app, APP_ID).catch(() => null),
    (r) => !!r && typeof r.path === 'string' && r.path.includes(route),
    15_000,
    500,
  )
}

/**
 * The stack main reports, once it has settled.
 *
 * Main drops its stored stack the moment a page closes and the shell republishes it from its next commit (see `disposePageSession` and the `notifyPageStack` effect), so a single snapshot taken right after a route entry that discards pages can land in that window and read empty.
 */
async function waitForPageStack(app: ElectronApplication): Promise<string[]> {
  const stack = await pollUntil(
    () => getPageStack(app, APP_ID).catch(() => []),
    (entries) => entries.length > 0,
    15_000,
    300,
  )
  return stack.map((e) => e.path)
}

test.describe('native-host page-stack orientation across route entries and rapid navigation', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(180_000)

  useSharedProject(test, FIXTURE_DIR)

  test.beforeAll(async ({ _workerElectron }) => {
    await waitForServicePageReady(_workerElectron.app, APP_ID)
  })

  // Device orientation is not part of useSharedProject's afterEach reset, so pin a known baseline before every test regardless of what the previous test rotated to.
  test.beforeEach(async ({ electronApp }) => {
    await rotateDevice(electronApp, 'portrait')
  })

  test('navigateBack({delta:2}) across a three-layer, cross-orientation stack lands on the bottom page\'s own orientation', async ({ electronApp }) => {
    await callWxMethod(electronApp, 'navigateTo', [{ url: '/' + PORTRAIT_ROUTE }])
    await waitForRoute(electronApp, PORTRAIT_ROUTE)
    await callWxMethod(electronApp, 'navigateTo', [{ url: '/' + MID_ROUTE }])
    await waitForRoute(electronApp, MID_ROUTE)
    const beforeBack = await waitForOrientation(electronApp, 'landscape')
    expect(beforeBack.windowWidth!, 'mid (inherited landscape) must be showing landscape before the multi-pop').toBeGreaterThan(beforeBack.windowHeight!)

    await callWxMethod(electronApp, 'navigateBack', [{ delta: 2 }])
    await waitForRoute(electronApp, ENTRY_ROUTE)
    const stack = await waitForPageStack(electronApp)
    expect(stack.join(','), 'popping 2 must discard both portraitpage and mid, leaving only entry').toContain(ENTRY_ROUTE)
    expect(stack.length, 'no leftover intermediate pages after a multi-level pop').toBe(1)

    const after = await waitForOrientation(electronApp, 'landscape')
    expect(
      after.windowWidth!,
      'landing 2 levels back must resolve to the LANDING page\'s own orientation (entry\'s inherited landscape), not the portrait page it skipped over',
    ).toBeGreaterThan(after.windowHeight!)
  })

  test('redirectTo across orientations replaces the stack top; there is no earlier page left to restore', async ({ electronApp }) => {
    await callWxMethod(electronApp, 'redirectTo', [{ url: '/' + PORTRAIT_ROUTE }])
    await waitForRoute(electronApp, PORTRAIT_ROUTE)
    const info = await waitForOrientation(electronApp, 'portrait')
    expect(info.windowHeight!, 'redirectTo must show the new page\'s own orientation').toBeGreaterThan(info.windowWidth!)

    const stack = await waitForPageStack(electronApp)
    expect(stack.length, 'redirectTo replaces the page it was called from — the landscape entry page it replaced is gone, not just hidden').toBe(1)
    expect(stack[0]).toContain(PORTRAIT_ROUTE)
  })

  test('reLaunch across orientations clears the whole stack to the new root page\'s own orientation', async ({ electronApp }) => {
    await callWxMethod(electronApp, 'navigateTo', [{ url: '/' + PORTRAIT_ROUTE }])
    await waitForRoute(electronApp, PORTRAIT_ROUTE)

    await callWxMethod(electronApp, 'reLaunch', [{ url: '/' + MID_ROUTE }])
    await waitForRoute(electronApp, MID_ROUTE)
    const stack = await waitForPageStack(electronApp)
    expect(stack.length, 'reLaunch clears the entire prior stack (entry + portraitpage), leaving only the new root').toBe(1)
    expect(stack[0]).toContain(MID_ROUTE)

    const info = await waitForOrientation(electronApp, 'landscape')
    expect(info.windowWidth!, 'the reLaunch target\'s own (inherited landscape) orientation must apply').toBeGreaterThan(info.windowHeight!)
  })

  test('a three-layer stack alternating landscape/portrait/landscape resolves each layer correctly on both the way in and the way back out', async ({ electronApp }) => {
    const entry = await waitForOrientation(electronApp, 'landscape')
    expect(entry.windowWidth!, 'layer 1 (entry): landscape').toBeGreaterThan(entry.windowHeight!)

    await callWxMethod(electronApp, 'navigateTo', [{ url: '/' + PORTRAIT_ROUTE }])
    await waitForRoute(electronApp, PORTRAIT_ROUTE)
    const layer2In = await waitForOrientation(electronApp, 'portrait')
    expect(layer2In.windowHeight!, 'layer 2 (portraitpage): portrait, entering').toBeGreaterThan(layer2In.windowWidth!)

    await callWxMethod(electronApp, 'navigateTo', [{ url: '/' + MID_ROUTE }])
    await waitForRoute(electronApp, MID_ROUTE)
    const layer3In = await waitForOrientation(electronApp, 'landscape')
    expect(layer3In.windowWidth!, 'layer 3 (mid): landscape, entering').toBeGreaterThan(layer3In.windowHeight!)

    await callWxMethod(electronApp, 'navigateBack', [{ delta: 1 }])
    await waitForRoute(electronApp, PORTRAIT_ROUTE)
    const layer2Out = await waitForOrientation(electronApp, 'portrait')
    expect(layer2Out.windowHeight!, 'layer 2 (portraitpage): portrait, on the way back out').toBeGreaterThan(layer2Out.windowWidth!)

    await callWxMethod(electronApp, 'navigateBack', [{ delta: 1 }])
    await waitForRoute(electronApp, ENTRY_ROUTE)
    const layer1Out = await waitForOrientation(electronApp, 'landscape')
    expect(layer1Out.windowWidth!, 'layer 1 (entry): landscape, on the way back out').toBeGreaterThan(layer1Out.windowHeight!)
  })

  test('rotating the device on an auto page (the rotate control\'s own reachable path), then visiting a fixed-portrait page and back, leaves the auto page following the current device — not the fixed page\'s orientation it just left', async ({ electronApp }) => {
    await callWxMethod(electronApp, 'navigateTo', [{ url: '/' + AUTO_ROUTE }])
    await waitForRoute(electronApp, AUTO_ROUTE)
    const baseline = await waitForOrientation(electronApp, 'portrait')
    expect(baseline.windowHeight!, 'auto page starts portrait, tracking the portrait device').toBeGreaterThan(baseline.windowWidth!)

    // The rotate control is enabled here: an 'auto' page's canRotate is true (orientation-controller.ts's canRotateFor), so this rotation is one a real user could trigger through the UI.
    await rotateDevice(electronApp, 'landscape')
    const rotated = await waitForOrientation(electronApp, 'landscape')
    expect(rotated.windowWidth!, 'the auto page follows the rotation to landscape').toBeGreaterThan(rotated.windowHeight!)

    await callWxMethod(electronApp, 'navigateTo', [{ url: '/' + PORTRAIT_ROUTE }])
    await waitForRoute(electronApp, PORTRAIT_ROUTE)
    const onFixed = await waitForOrientation(electronApp, 'portrait')
    expect(onFixed.windowHeight!, 'the fixed portrait page forces portrait regardless of the (landscape) device').toBeGreaterThan(onFixed.windowWidth!)

    await callWxMethod(electronApp, 'navigateBack', [{ delta: 1 }])
    await waitForRoute(electronApp, AUTO_ROUTE)
    const back = await waitForOrientation(electronApp, 'landscape')
    expect(
      back.windowWidth!,
      'back on the auto page, it must show landscape (the current device) — not the portrait it just displayed on the fixed page it left',
    ).toBeGreaterThan(back.windowHeight!)
  })

  test('the device orientation changing while a fixed-orientation page is on screen (the rotate control is disabled for it, but the device state itself can still move — e.g. a device-model switch) is picked up by the auto page underneath once control returns to it', async ({ electronApp }) => {
    await callWxMethod(electronApp, 'navigateTo', [{ url: '/' + AUTO_ROUTE }])
    await waitForRoute(electronApp, AUTO_ROUTE)
    const baseline = await waitForOrientation(electronApp, 'portrait')
    expect(baseline.windowHeight!, 'auto page starts portrait, tracking the portrait device').toBeGreaterThan(baseline.windowWidth!)

    await callWxMethod(electronApp, 'navigateTo', [{ url: '/' + MID_ROUTE }])
    await waitForRoute(electronApp, MID_ROUTE)
    const onFixed = await waitForOrientation(electronApp, 'landscape')
    expect(onFixed.windowWidth!, 'mid (inherited landscape) is fixed regardless of the device').toBeGreaterThan(onFixed.windowHeight!)

    // mid's canRotate is false — the rotate control is disabled while it is the top page — but the device's own orientation is still driven here through the same hook the rest of this suite uses, standing in for a non-rotate-control source of a device change (e.g. switching the simulated device model in the toolbar).
    await rotateDevice(electronApp, 'landscape')
    await new Promise((r) => setTimeout(r, 500))
    const stillFixed = await readServiceSystemInfo(electronApp)
    expect(stillFixed.windowWidth!, 'mid stays landscape — a fixed page never reacts to the device').toBeGreaterThan(stillFixed.windowHeight!)

    await callWxMethod(electronApp, 'navigateBack', [{ delta: 1 }])
    await waitForRoute(electronApp, AUTO_ROUTE)
    const back = await waitForOrientation(electronApp, 'landscape')
    expect(
      back.windowWidth!,
      'the auto page must pick up the device\'s NEW orientation (landscape) on return — not the portrait it displayed before the fixed page took over',
    ).toBeGreaterThan(back.windowHeight!)
  })

  test('navigateTo a landscape page immediately followed by navigateBack, before its own orientation round trip necessarily lands, ends in a consistent state on the originating page', async ({ electronApp }) => {
    await callWxMethod(electronApp, 'navigateTo', [{ url: '/' + AUTO_ROUTE }])
    await waitForRoute(electronApp, AUTO_ROUTE)
    const baselineStack = await getPageStack(electronApp, APP_ID)

    // callWxMethod's own await (runNativeHostNav → waitForActivePage in electron-entry.js) DOES wait for the active page to switch to the page just navigated to — so by the time the first call below resolves, mid IS the active page.
    // What it does NOT wait for is mid's own orientation/geometry round trip: DeviceShell computes the effective orientation and relays it back over PAGE_RESIZE as a separate, uncoordinated step after the active-page switch.
    // Firing navigateBack immediately, with no waitForRoute()/waitForOrientation() in between, races that in-flight PAGE_RESIZE against the pop — a late PAGE_RESIZE computed for mid must not land on (or get attributed to) whatever page is on top by the time it arrives.
    await callWxMethod(electronApp, 'navigateTo', [{ url: '/' + MID_ROUTE }])
    await callWxMethod(electronApp, 'navigateBack', [{ delta: 1 }])

    await waitForRoute(electronApp, AUTO_ROUTE)
    const stack = await pollUntil(
      () => getPageStack(electronApp, APP_ID),
      (s) => s.length === baselineStack.length,
      15_000,
      400,
    )
    expect(stack.length, 'the push/pop pair must cancel out — no orphaned mid page left on the stack').toBe(baselineStack.length)

    const info = await waitForOrientation(electronApp, 'portrait')
    expect(
      info.windowHeight!,
      'the final state must be the auto page\'s own (portrait) orientation — not stuck on mid\'s landscape mid-transition',
    ).toBeGreaterThan(info.windowWidth!)
  })
})
