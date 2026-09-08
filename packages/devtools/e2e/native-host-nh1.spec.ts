/**
 * E2E (native-host merged group "NH-1"): captureThumbnail render-guest
 * sizing, the white-screen reconcile regression guard, App.callWxMethod
 * routing for a non-nav wx method, the DevTools Elements render-guest
 * forwarding hook, and the popover 重新编译 recompile+relaunch contract.
 *
 * These five specs launch electron-entry.js with byte-identical
 * DIMINA_NATIVE_HOST=1 args/env against the same tabbar-app fixture and each
 * used to pay its own ~16.7s Electron cold boot for a single beforeAll. They
 * are merged into one shared launch + one opened project.
 *
 * Ordering is load-bearing, not cosmetic:
 *  - `white-screen-reconcile` drives the device picker through 4 presets and
 *    resets to the default device at the end of its own test — later tests
 *    (and later spec files sharing this worker) must not inherit a
 *    non-default device.
 *  - `recompile-button-recompiles` must run LAST: its second test edits
 *    source on disk, changes the selected compile start page and forces a
 *    real recompile+relaunch onto pages/cart/cart. Any test after it would
 *    run against the wrong start page. The shared afterAll restores both
 *    mutated files (home.wxml, project.config.json) unconditionally so the
 *    on-disk fixture — and the compile-mode list that governs the start page
 *    for the next run — is back to its pre-suite state regardless of which
 *    tests ran or failed.
 */
import { test, expect, _electron, type ElectronApplication, type Page as PwPage } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { WebSocket } from 'ws'
import {
  openProjectInUI,
  waitForSimulatorWebview,
  closeProject,
  ipcInvoke,
  pollUntil,
  evalInSimulator,
  evalInWebContentsByUrl,
  RENDER_GUEST_URL_MARKER,
  findMainWindow,
  selectDeviceInPicker,
  openCompileModePopover,
  clickCompileModeMenuRow,
  clickCompileModeMenuAction,
  fillCompileModeForm,
  submitCompileModeForm,
} from './helpers'
import {
  ProjectChannel,
  AutomationChannel,
  SimulatorWxmlChannel,
  WorkbenchSettingsChannel,
} from '../src/shared/ipc-channels'
import { DEFAULT_DEVICE, DEVICE_NAMES, findDevice } from '@devicekit/devices'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = path.resolve(__dirname, 'fixtures', 'tabbar-app')
const HOME_WXML = path.join(FIXTURE_DIR, 'pages', 'home', 'home.wxml')
const PROJECT_CONFIG_PATH = path.join(FIXTURE_DIR, 'project.config.json')
const PROBE_TITLE = 'C5-PROBE'
const SENTINEL = 'RECOMPILE-BUTTON-SENTINEL'

interface WxmlNode { tagName?: string; children?: WxmlNode[] }

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

// Cycle across presets with different widths AND heights so each switch changes
// the simulator column width → dock relayout → the geometry sentinel opens,
// reproducing the transient that used to detach the view.
const CYCLE = [
  DEFAULT_DEVICE,
  findDevice(DEVICE_NAMES.iPhone_14_Pro),
  findDevice(DEVICE_NAMES.iPhone_16_Pro),
  findDevice(DEVICE_NAMES.iPhone_SE) ?? DEFAULT_DEVICE,
].filter(Boolean) as { name: string }[]

let electronApp: ElectronApplication
let mainWindow: PwPage
let workbench: PwPage
let autoPort = 0
let originalWxml = ''
let originalProjectConfig = ''

async function selectDevice(win: PwPage, deviceName: string): Promise<void> {
  await selectDeviceInPicker(win, electronApp, deviceName)
}

// One-shot JSON-RPC call to the miniprogram-automator WebSocket server. Shared
// by the wx-method and recompile-button tests below (they never run
// concurrently — this describe is serial — so a single RPC id is safe).
function wsCall<T = Record<string, unknown>>(
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 12000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${autoPort}`)
    const timer = setTimeout(() => { ws.close(); reject(new Error(`wsCall ${method} timed out`)) }, timeoutMs)
    ws.on('open', () => ws.send(JSON.stringify({ id: 'nh1-merged-rpc', method, params })))
    ws.on('message', (raw) => {
      let msg: { id?: string; result?: unknown; error?: { message?: string } }
      try { msg = JSON.parse(String(raw)) } catch { return }
      if (msg.id !== 'nh1-merged-rpc') return
      clearTimeout(timer)
      ws.close()
      if (msg.error) reject(new Error(msg.error.message || 'rpc error'))
      else resolve(msg.result as T)
    })
    ws.on('error', (err) => { clearTimeout(timer); reject(err) })
  })
}

async function navBarTitle(): Promise<string> {
  return evalInSimulator<string>(
    electronApp,
    `(() => { const e = document.querySelector('.nav-bar__title-text'); return e ? (e.textContent || '') : '' })()`,
  ).catch(() => '')
}

async function readActivePageText(): Promise<string> {
  return evalInWebContentsByUrl<string>(
    electronApp,
    RENDER_GUEST_URL_MARKER,
    'document.body.innerText',
  ).catch(() => '')
}

/**
 * Reproduce "unchanged start page, force a real recompile" — the popover no
 * longer has an inline 重新编译 button; instead `handleSelect` in popover.tsx
 * always sends `relaunch: true`, even when reselecting the row that is
 * already current. Re-clicking 普通编译 while it is selected therefore
 * triggers the same recompile+relaunch-at-entry-page contract the old
 * button did, without creating any custom mode.
 */
async function reselectNormalCompileInPopover(): Promise<void> {
  await openCompileModePopover(workbench, electronApp)
  await clickCompileModeMenuRow(electronApp, '普通编译')
}

/**
 * Reproduce "pick a different start page, then trigger 重新编译" — the new
 * popover collapses that into one action: creating a mode sends an `add`
 * command, main's `CompileModeStore` appends the new entry and selects it,
 * and that always relaunches, so filling and submitting the "添加编译模式"
 * form both selects the page AND fires the same real recompile.
 */
async function createAndLaunchCompileMode(pathName: string): Promise<void> {
  await openCompileModePopover(workbench, electronApp)
  await clickCompileModeMenuAction(electronApp, '添加编译模式')
  await fillCompileModeForm(electronApp, { pathName })
  await submitCompileModeForm(electronApp)
}

/**
 * Execute JavaScript in the DevTools front-end realm (devtools:// page).
 * Returns null on any error (front-end not yet ready, wc gone, etc.).
 */
function evalInDevtools<T>(app: ElectronApplication, expression: string): Promise<T | null> {
  return evalInWebContentsByUrl<T>(app, 'devtools://', expression).catch(() => null)
}

/**
 * Send a DOM.getDocument command via the WRAPPED InspectorFrontendHost
 * (the same path the Elements panel uses) and capture the first response with
 * a matching id via window.DevToolsAPI.dispatchMessage interception.
 *
 * The capture arms a one-shot `dispatchMessage` interceptor BEFORE sending the
 * command, so the response never races. The interceptor is removed after the
 * first matching reply (or on timeout).
 */
async function getDocumentViaFrontend(
  app: ElectronApplication,
  timeoutMs = 4000,
): Promise<Record<string, unknown> | null> {
  return evalInWebContentsByUrl<Record<string, unknown> | null>(
    app,
    'devtools://',
    `(function() {
      return new Promise(function(resolve) {
        try {
          var IFH = globalThis.InspectorFrontendHost;
          var DTAPI = window.DevToolsAPI;
          if (!IFH || typeof IFH.sendMessageToBackend !== 'function') {
            return resolve(null);
          }
          if (!DTAPI || typeof DTAPI.dispatchMessage !== 'function') {
            return resolve(null);
          }

          var cmdId = Date.now();
          var settled = false;
          var timer = setTimeout(function() {
            if (settled) return;
            settled = true;
            window.DevToolsAPI.dispatchMessage = origDispatch;
            resolve(null);
          }, ${timeoutMs});

          var origDispatch = DTAPI.dispatchMessage.bind(DTAPI);

          // Intercept dispatchMessage to capture the response with our cmdId.
          DTAPI.dispatchMessage = function(messageStr) {
            try {
              var msg = (typeof messageStr === 'string') ? JSON.parse(messageStr) : messageStr;
              if (msg && msg.id === cmdId && !settled) {
                settled = true;
                clearTimeout(timer);
                window.DevToolsAPI.dispatchMessage = origDispatch;
                origDispatch(messageStr);
                resolve(msg);
                return;
              }
            } catch(_) {}
            origDispatch(messageStr);
          };

          // Send DOM.getDocument via the (possibly wrapped) sendMessageToBackend.
          IFH.sendMessageToBackend(JSON.stringify({
            id: cmdId,
            method: 'DOM.getDocument',
            params: { depth: 2 }
          }));
        } catch(e) {
          resolve(null);
        }
      });
    })()`,
  ).catch(() => null)
}

test.describe('native-host NH-1: thumbnail capture + white-screen reconcile + wx-method + devtools elements + recompile button', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(180_000)

  test.beforeAll(async () => {
    // Extend the hook timeout: this beforeAll now stacks every readiness poll
    // the 5 original files used to spread across 5 separate beforeAll hooks
    // (render guest, DeviceShell, WXML tree) on top of one Electron cold
    // boot. Setting it INSIDE the hook overrides the hook's own budget (the
    // describe-level setTimeout only covers tests).
    test.setTimeout(240_000)

    originalWxml = fs.readFileSync(HOME_WXML, 'utf8')
    originalProjectConfig = fs.readFileSync(PROJECT_CONFIG_PATH, 'utf8')

    const appPath = path.resolve(__dirname, 'electron-entry.js')
    const userDataDir = path.resolve(
      process.env.DIMINA_DEVTOOLS_DATA_DIR
        ?? path.resolve(__dirname, '..', 'node_modules', '.cache', 'devtools-e2e'),
      'userdata',
      `nh1-merged-${process.pid}`,
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

    mainWindow = await findMainWindow(electronApp)
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

    autoPort = await pollUntil(
      () => ipcInvoke<number | null>(mainWindow, AutomationChannel.GetPort),
      (val) => typeof val === 'number' && val > 0,
      10000,
      100,
    ) as number

    // recompile-button-recompiles (the last test below) needs autoBuild off
    // BEFORE the project opens, so openProject never starts a chokidar
    // watcher — that's the only way to isolate "the button itself forced a
    // recompile" from "the watcher already picked up the edit". None of the
    // other merged tests touch FIXTURE_DIR source files or depend on live
    // auto-rebuild, so disabling it for the whole shared session is safe for
    // them too.
    const settings = await ipcInvoke<{ compile: { autoBuild: boolean }, [k: string]: unknown }>(
      mainWindow,
      WorkbenchSettingsChannel.Get,
    )
    await ipcInvoke(mainWindow, WorkbenchSettingsChannel.Save, {
      ...settings,
      compile: { ...settings.compile, autoBuild: false },
    })

    workbench = await openProjectInUI(electronApp, FIXTURE_DIR, { waitMs: 20000 })
    await waitForSimulatorWebview(electronApp)

    // Render guest readiness — captureThumbnail falls back to the outer WVC
    // when the guest is absent, and devtools-elements needs it to route into,
    // so both must run only after the guest (__frame__.html) is mounted.
    await pollUntil(
      () => electronApp.evaluate(({ webContents }, marker) =>
        webContents.getAllWebContents().some(
          (wc) => !wc.isDestroyed() && wc.getURL().includes(marker),
        ),
      RENDER_GUEST_URL_MARKER),
      (present) => present === true,
      30000,
      300,
    )

    // DeviceShell readiness — white-screen-reconcile and recompile-button
    // drive the real UI against it; wx-method re-asserts this explicitly in
    // its own test body (kept as a first-class assertion, not just a gate).
    await pollUntil(
      () => evalInSimulator<boolean>(
        electronApp,
        `(() => !!document.querySelector('.device-shell-root'))()`,
      ).catch(() => false),
      (ok) => ok === true,
      25000,
      300,
    )

    // WXML tree readiness — the signal the WXML panel uses; devtools-elements
    // needs the render guest fully set up before probing DOM.getDocument.
    await pollUntil(
      () => ipcInvoke<WxmlNode | null>(workbench, SimulatorWxmlChannel.GetSnapshot).catch(() => null),
      (t) => !!t && typeof (t as WxmlNode).tagName === 'string',
      30000,
      400,
    )
  })

  test.afterAll(async () => {
    // recompile-button-recompiles (last test) edits both files on disk;
    // restore them unconditionally regardless of which tests ran/failed so
    // the git-tracked fixture is back to its pre-suite state for the next spec.
    fs.writeFileSync(HOME_WXML, originalWxml)
    fs.writeFileSync(PROJECT_CONFIG_PATH, originalProjectConfig)
    await closeProject(electronApp).catch(() => {})
    await electronApp?.close().catch(() => {})
  })

  test('thumbnail PNG dimensions match the render guest, not the outer simulator WVC', async () => {
    // Measure the pixel dimensions of the outer simulator WVC (simulator.html)
    // and the render guest (__frame__.html) via PNG header in the main process.
    // Both captures happen before the IPC call so the timing is deterministic.
    const wcSizes = await electronApp.evaluate(async ({ webContents }, marker) => {
      const all = webContents.getAllWebContents()
      const simWc = all.find(
        (wc) => wc.getURL().includes('simulator.html') && !wc.isDestroyed(),
      )
      const guestWc = all.find(
        (wc) => wc.getURL().includes(marker) && !wc.isDestroyed(),
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
    }, RENDER_GUEST_URL_MARKER)

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
      workbench,
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

  test('repeated device switches keep the simulator content view visible (no white screen)', async () => {
    // Rapid-fire switches: a short gap so each triggers a relayout while the
    // previous sentinel window may still be open — the conditions that used to
    // strand the view detached.
    for (let i = 0; i < 16; i++) {
      await selectDevice(workbench, CYCLE[i % CYCLE.length]!.name)
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

    // Isolation: this test left the device on whatever CYCLE ended on
    // (iPhone SE). Reset to the default device before any later test in this
    // shared session runs — native-host-thumbnail-capture's PNG-size
    // discriminator assumes a fixed relationship between the outer WVC and
    // render-guest dimensions for the CURRENT device, and later tests should
    // not inherit a non-default device just because they happen to run after
    // this one in the same Electron instance.
    await selectDevice(workbench, DEFAULT_DEVICE.name)
    await pollUntil(
      () => evalInSimulator<string>(electronApp, 'document.visibilityState').catch(() => ''),
      (v) => v === 'visible',
      10000,
      200,
    )
  })

  test('App.callWxMethod setNavigationBarTitle updates the DeviceShell nav bar (service-host wx.*)', async () => {
    // Gate on the native render path being live (DeviceShell mounted), same as
    // the sibling render spec: this proves the service host + automation
    // pipeline are up before we drive the RPC.
    const shellMounted = await pollUntil(
      () => evalInSimulator<boolean>(
        electronApp,
        `(() => !!document.querySelector('.device-shell-root'))()`,
      ).catch(() => false),
      (ok) => ok === true,
      25000,
      300,
    )
    expect(shellMounted, 'DeviceShell .device-shell-root should mount under DIMINA_NATIVE_HOST=1').toBe(true)

    // Baseline: the entry page's window config overrides the app-level default
    // ("TabBar Fixture") with "Home", and is not already our probe value (so
    // the post-call assertion is meaningful).
    const before = await pollUntil(
      () => navBarTitle(),
      (t) => typeof t === 'string' && t.length > 0,
      25000,
      300,
    )
    expect(before, 'nav-bar title should render the entry page title before the call').toBe('Home')
    expect(before, 'baseline title must differ from the probe value').not.toBe(PROBE_TITLE)

    // The contract under test: a NON-navigation wx method invoked via
    // App.callWxMethod must run on the running mini-app's authoritative
    // (service-host) `wx`, so its UI effect is real. Under native-host today
    // this REJECTS ("wx.setNavigationBarTitle is not a function") because the
    // call lands on the simulator top-window `wx`, which lacks this method.
    await wsCall('App.callWxMethod', { method: 'setNavigationBarTitle', args: [{ title: PROBE_TITLE }] })

    // The effect flows service-host wx → DeviceShell nav-bar reducer → DOM.
    const after = await pollUntil(
      () => navBarTitle(),
      (t) => t === PROBE_TITLE,
      15000,
      400,
    )
    expect(after, `DeviceShell nav-bar title should update to ${PROBE_TITLE} via service-host wx`).toBe(PROBE_TITLE)
  })

  test('elements-forward hook sentinels are installed in the DevTools front-end realm', async () => {
    // The hook is installed by a polling interval (up to ~10s after dom-ready).
    // Poll until both sentinels appear so we don't race the install timer.
    const hookInstalled = await pollUntil(
      () => evalInDevtools<boolean>(
        electronApp,
        '!!(globalThis.__diminaElementsHookInstalled === true && ' +
        'globalThis.InspectorFrontendHost && ' +
        'globalThis.InspectorFrontendHost.__diminaElementsWrapped === true)',
      ),
      (ok) => ok === true,
      30000,
      300,
    )

    expect(
      hookInstalled,
      'DevTools front-end (devtools://) must have __diminaElementsHookInstalled=true ' +
      'and InspectorFrontendHost.__diminaElementsWrapped=true — the elements-forward hook is not installed',
    ).toBe(true)
  })

  test('DOM.getDocument via the front-end hook returns the render guest document (__frame__.html), not the service host', async () => {
    // Wait until the hook is installed before probing (may have already settled
    // from the previous test, but this describe is serial so the guard is cheap).
    await pollUntil(
      () => evalInDevtools<boolean>(
        electronApp,
        '!!(globalThis.__diminaElementsHookInstalled)',
      ),
      (ok) => ok === true,
      15000,
      300,
    )

    // Retry the getDocument call: the drain interval is 150ms and the render guest
    // may still be priming (DOM.enable in flight). A few retries handle that window.
    let response: Record<string, unknown> | null = null
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      response = await getDocumentViaFrontend(electronApp, 4000)
      if (response && response.result) break
      await new Promise((r) => setTimeout(r, 500))
    }

    expect(
      response,
      'DOM.getDocument sent via InspectorFrontendHost.sendMessageToBackend must receive a response within 30s',
    ).toBeTruthy()

    const result = (response as { result?: { root?: { documentURL?: string; baseURL?: string } } })?.result
    expect(
      result,
      `DOM.getDocument response should have a "result" field; got: ${JSON.stringify(response)}`,
    ).toBeTruthy()

    const root = result?.root
    expect(
      root,
      `DOM.getDocument result should contain a "root" node; got result=${JSON.stringify(result)}`,
    ).toBeTruthy()

    // The discriminating assertion: the root document URL must point to the render
    // guest (__frame__.html). When elements-forward is absent or broken, this URL
    // resolves to the service host's own document (containing "service.html" or
    // having title "Dimina Service Host").
    const docUrl: string = String(root?.documentURL ?? root?.baseURL ?? '')

    expect(
      docUrl,
      `DOM.getDocument root.documentURL should point to the render guest (__frame__.html) ` +
      `but got: "${docUrl}". This means Elements is inspecting the service host instead of the render guest.`,
    ).toContain(RENDER_GUEST_URL_MARKER)

    expect(
      docUrl,
      `DOM.getDocument root.documentURL must not point to the service host (service.html); got: "${docUrl}"`,
    ).not.toContain('service.html')
  })

  test('clicking 重新编译 recompiles the edited source and shows it — no auto-rebuild happens first', async () => {
    // ── Sanity: the entry page renders its pre-edit content. ────────────────
    const initial = await pollUntil(
      () => readActivePageText(),
      (txt) => txt.includes('HOME PAGE'),
      20000,
      400,
    )
    expect(initial).toContain('HOME PAGE')

    // ── Edit the source on disk WITHOUT going through the app — autoBuild is
    // off, so no watcher exists to pick this up. ────────────────────────────
    fs.writeFileSync(
      HOME_WXML,
      originalWxml.replace('HOME PAGE', `HOME PAGE ${SENTINEL}`),
    )

    // ── Confirm the edit does NOT surface on its own within a generous
    // window — proves there is no live auto-compile in this configuration. ──
    await new Promise((resolve) => setTimeout(resolve, 8000))
    const stillStale = await readActivePageText()
    expect(
      stillStale.includes(SENTINEL),
      'autoBuild is off — the sentinel must NOT appear without an explicit recompile',
    ).toBe(false)

    // ── Reselect 普通编译 in the popover — this must trigger a REAL recompile,
    // not just a reattach to the stale build. ────────────────────────────────
    await reselectNormalCompileInPopover()

    const afterRecompile = await pollUntil(
      () => readActivePageText(),
      (txt) => txt.includes(SENTINEL),
      30000,
      500,
    )
    expect(
      afterRecompile,
      '重新编译 must recompile the edited source and reload onto it — a reattach-only implementation would still show the stale build',
    ).toContain(SENTINEL)
  })

  test('changing the compile start page then clicking 重新编译 opens that page', async () => {
    const routeBefore = await pollUntil(
      () => wsCall<{ path?: string }>('App.getCurrentPage').catch(() => null),
      (page) => !!page?.path?.includes('pages/home/home'),
      20000,
      500,
    )
    expect(routeBefore?.path).toContain('pages/home/home')

    const before = await pollUntil(
      () => readActivePageText(),
      (txt) => txt.includes('HOME PAGE'),
      20000,
      400,
    )
    expect(before).toContain('HOME PAGE')

    await createAndLaunchCompileMode('pages/cart/cart')

    const routeAfter = await pollUntil(
      () => wsCall<{ path?: string }>('App.getCurrentPage').catch(() => null),
      (page) => !!page?.path?.includes('pages/cart/cart'),
      30000,
      500,
    )
    expect(
      routeAfter?.path,
      '重新编译后的 active page route must be pages/cart/cart instead of the previous HOME route',
    ).toContain('pages/cart/cart')

    const afterRecompile = await pollUntil(
      () => readActivePageText(),
      (txt) => txt.includes('CART PAGE'),
      30000,
      500,
    )
    expect(
      afterRecompile,
      '首页 → 选择 pages/cart/cart → 重新编译 must relaunch the simulator at CART instead of retaining HOME',
    ).toContain('CART PAGE')
    expect(afterRecompile).not.toContain('HOME PAGE')
  })
})
