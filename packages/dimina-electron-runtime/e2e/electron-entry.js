// E2E test entry for @dimina-kit/electron-runtime's own Playwright suite.
//
// Wires the package's PUBLIC embedding facade exactly as documented in
// README.md, then exposes a small set of test-only introspection/automation
// hooks on `globalThis.__diminaE2eHooks`. Playwright drives this SAME main
// process directly via `electronApp.evaluate()` — there is no automation
// server / WebSocket RPC layer here (unlike devtools' `--auto` mode), because
// nothing outside this process needs to reach in.
import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createElectronRuntime,
  registerElectronRuntimeSchemes,
} from '@dimina-kit/electron-runtime'
import { openProject as devkitOpenProject } from '@dimina-kit/devkit'
import { AppDataAccumulator, decodeWorkerMessage, decodedToInput } from '@dimina-kit/inspect'
import { deviceInfoToHostEnv } from '@dimina-kit/electron-runtime/shared/bridge-channels'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const WINDOW_WIDTH = 390
const WINDOW_HEIGHT = 844
const NAV_METHODS = new Set(['navigateTo', 'redirectTo', 'reLaunch', 'switchTab'])

// Same off-screen + focus-steal neutering as packages/devtools/e2e/electron-entry.js
// (test-only; keeps the developer running the suite locally from losing focus).
if (process.platform === 'darwin') {
  app.whenReady().then(() => {
    try { app.dock?.hide() } catch { /* not on darwin, or already hidden */ }
  })
}
const moveOffscreen = (win) => {
  try {
    win.setPosition(-2000, -2000)
    if (typeof win.blur === 'function') win.blur()
  } catch { /* window may already be closing */ }
}
app.on('browser-window-created', (_e, win) => {
  try {
    win.once('ready-to-show', () => moveOffscreen(win))
    win.on('show', () => moveOffscreen(win))
    win.on('focus', () => { try { win.blur() } catch { /* closing */ } })
    win.focus = () => { try { win.blur() } catch { /* closing */ } }
  } catch { /* closing */ }
})

// Everything below runs inside an async IIFE rather than as top-level
// `await` — on this Electron/Node combination, top-level `await` in the ESM
// entry module's own top-level scope hangs `app.whenReady()` forever (no
// error, no crash, no child process — verified in isolation with a minimal
// repro). The exact same `await` sequence inside a non-top-level async
// function resolves normally, so everything past the static imports and
// event-listener registration above is deferred into one.
void (async () => {

registerElectronRuntimeSchemes()
await app.whenReady()

const hostWindow = new BrowserWindow({
  width: WINDOW_WIDTH,
  height: WINDOW_HEIGHT,
  webPreferences: {
    preload: path.join(__dirname, 'test-preload.cjs'),
    contextIsolation: true,
  },
})
// The host window never shows real UI — it only needs to exist as a renderer
// process for test-preload.cjs's contextBridge API (window.__diminaTestIpc)
// to attach to, for the small number of specs that drive raw `dmb:*` IPC.
await hostWindow.loadURL('data:text/html,<title>dimina-electron-runtime e2e host</title>')

const runtime = await createElectronRuntime({
  hostWindow,
  adapter: { openProject: devkitOpenProject },
})

let currentSession = null

// -- Page-data tap: mirrors packages/devtools/src/main/services/simulator-appdata
// (setupSimulatorAppData), reimplemented against the PUBLIC `runtime.on(...)`
// event surface instead of devtools' internal AppDataTap wiring. -----------
const appDataAccumulators = new Map()

function accumulatorFor(appId) {
  let acc = appDataAccumulators.get(appId)
  if (!acc) {
    acc = new AppDataAccumulator()
    appDataAccumulators.set(appId, acc)
  }
  return acc
}

runtime.on('app-data-message', ({ appId, message }) => {
  const entries = decodeWorkerMessage(message)
  if (!entries) return
  const acc = accumulatorFor(appId)
  for (const entry of entries) acc.apply(decodedToInput(entry))
})

runtime.on('app-data-evict', ({ appId, bridgeId }) => {
  appDataAccumulators.get(appId)?.clearBridge(bridgeId)
})

function resolveAppDataPath(data, pathKey) {
  if (!pathKey) return data
  const keys = pathKey.replace(/\[(\d+)\]/g, '.$1').split('.')
  let val = data
  for (const k of keys) {
    if (val == null || typeof val !== 'object') return undefined
    val = val[k]
  }
  return val
}

// -- Bridge-backed introspection: ports packages/devtools/src/main/services/
// automation/{handlers/app.ts,exec.ts,wait-active-page.ts} against the
// process-global `__diminaBridgeHandle` bridge-router.ts exposes under
// NODE_ENV=test, since createElectronRuntime()'s public facade doesn't return
// the bridge handle itself. -------------------------------------------------
function getBridge() {
  const bridge = globalThis.__diminaBridgeHandle
  if (!bridge) throw new Error('[e2e] bridge-router handle not installed yet')
  return bridge
}

/** Decode `pagePath?k=v` into `{ pagePath, query }` (mirrors devtools' simulator-route.ts). */
function decodePageSpec(value) {
  const qIdx = value.indexOf('?')
  if (qIdx < 0) return { pagePath: value, query: {} }
  const pagePath = value.slice(0, qIdx)
  const query = {}
  for (const pair of value.slice(qIdx + 1).split('&')) {
    if (!pair) continue
    const eqIdx = pair.indexOf('=')
    const k = eqIdx >= 0 ? pair.slice(0, eqIdx) : pair
    const v = eqIdx >= 0 ? pair.slice(eqIdx + 1) : ''
    if (k) query[decodeURIComponent(k)] = decodeURIComponent(v)
  }
  return { pagePath, query }
}

async function getCurrentPage(appId) {
  const bridge = getBridge()
  const renderWc = bridge.getActiveRenderWc(appId)
  if (!renderWc) return { pageId: 1, path: '', query: {} }
  const search = await renderWc.executeJavaScript('location.search').catch(() => '')
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  const pagePath = params.get('pagePath') || ''
  if (!pagePath) return { pageId: 1, path: '', query: {} }
  const spec = decodePageSpec(pagePath)
  return { pageId: 1, path: spec.pagePath, query: spec.query }
}

function getPageStack(appId) {
  const bridge = getBridge()
  const stack = bridge.getPageStack?.(appId)
  if (!stack || stack.length === 0) return []
  return stack.map((entry, i) => ({
    pageId: i + 1,
    path: entry.pagePath,
    query: Object.fromEntries(Object.entries(entry.query ?? {}).map(([k, v]) => [k, String(v)])),
  }))
}

/**
 * The routes the SERVICE host's own page stack currently holds (`getCurrentPages()`), resolved through the bridge so it always reads the session that owns `appId` — never a not-yet-destroyed service window from a just-closed session.
 *
 * `getCurrentPage` above answers a different question: it reads `pagePath` off the RENDER guest's URL, which is fixed at guest-creation time, long before the service host has booted its bundle and instantiated the root `Page`.
 * The route APIs (`navigateTo`/`redirectTo`/`switchTab`/`reLaunch`) resolve their `url` against `router.getPageInfo().route` in the service host, so they need THIS fact, not the render guest's URL.
 *
 * Returns `[]` when no service host is connected yet.
 */
async function getServicePageRoutes(appId) {
  const bridge = getBridge()
  const serviceWc = bridge.getServiceWc(appId)
  if (!serviceWc || serviceWc.isDestroyed() || serviceWc.isLoading()) return []
  return serviceWc.executeJavaScript(`(() => {
    if (typeof getCurrentPages !== 'function') return []
    return getCurrentPages().map((p) => (p && p.route) || '')
  })()`).catch(() => [])
}

function getPageData(appId, path) {
  const bridge = getBridge()
  const bridgeId = bridge.getActiveBridgeId(appId)
  const data = bridgeId ? (appDataAccumulators.get(appId)?.pageData(bridgeId) ?? {}) : {}
  return resolveAppDataPath(data, path)
}

/** Ports wait-active-page.ts's timeout-floor "wait for the bridge's next activePage signal". */
function waitForActivePage(bridge, { since, timeoutMs }) {
  return new Promise((resolve) => {
    let settled = false
    let unsubscribe = null
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      unsubscribe?.()
      resolve()
    }
    unsubscribe = bridge.onRenderEvent((event) => {
      if (settled || event.kind !== 'activePage') return
      if (event.bridgeId !== since) finish()
    })
    const timer = setTimeout(finish, timeoutMs)
    const current = bridge.getActiveBridgeId()
    if (current !== null && current !== since) finish()
  })
}

/**
 * Under sustained load the `executeJavaScript` dispatch below can occasionally
 * reject with a generic, detail-free error (observed: "Script failed to
 * execute") that doesn't say whether `wx.<method>(...)` actually ran in the
 * renderer before the round-trip back here broke.
 *
 * This deliberately does NOT retry. Two prior attempts at a safe retry were
 * tried and rejected on review: (1) a Playwright-side compensation check
 * matching the target path via a later `getCurrentPage` call — unsound, both
 * a false-positive substring match against unrelated routes and a race
 * against the very signal it was reading; (2) comparing `bridge.
 * getActiveBridgeId()` against a pre-dispatch snapshot here — still unsound,
 * since `ACTIVE_PAGE` carries no correlation to a specific invocation (an
 * unrelated concurrent navigation, or a same-tab `switchTab` that legitimately
 * keeps the same bridge id, both defeat it either direction). A genuinely safe
 * retry needs a per-invocation correlation/idempotency token threaded through
 * the actual nav protocol (NAV_ACTION/NAV_CALLBACK or equivalent) — a
 * production bridge-protocol change, not something worth doing just to
 * suppress a rare test-only flake. Don't reintroduce an in-band signal
 * comparison as a substitute; it can't establish causality.
 */
async function runNativeHostNav(bridge, serviceWc, method, args) {
  const arg = method === 'navigateBack' ? (args[0] ?? { delta: 1 }) : (args[0] ?? {})
  const since = bridge.getActiveBridgeId()
  // `executeJavaScript` does not marshal a thrown renderer error back here: any exception inside the dispatched script surfaces as Electron's fixed, detail-free "Script failed to execute" string, with the real message and stack reachable only from the service host's own console.
  // So the script RETURNS its outcome instead of throwing, and main re-raises it with the renderer's message/stack attached.
  // Promise semantics are preserved: the script still resolves through whatever `wx.<method>()` returns, so a rejected nav still fails this call — just with a readable reason.
  const outcome = await serviceWc.executeJavaScript(`(() => {
    const describe = (e) => ({ msg: String((e && e.message) || e), stack: String((e && e.stack) || '') })
    try {
      if (typeof wx === 'undefined') return { ok: false, phase: 'no-wx' }
      if (typeof wx.${method} !== 'function') return { ok: false, phase: 'no-method' }
      return Promise.resolve(wx.${method}(${JSON.stringify(arg)})).then(
        () => ({ ok: true }),
        (e) => ({ ok: false, phase: 'rejected', ...describe(e) }),
      )
    } catch (e) {
      return { ok: false, phase: 'threw', ...describe(e) }
    }
  })()`)
  if (!outcome.ok) {
    throw new Error(
      `[e2e] wx.${method}(${JSON.stringify(arg)}) ${outcome.phase} in the service host`
      + `${outcome.msg ? `: ${outcome.msg}` : ''}${outcome.stack ? `\n${outcome.stack}` : ''}`,
    )
  }
  const timeoutMs = method === 'navigateBack' ? 1500 : 2000
  await waitForActivePage(bridge, { since, timeoutMs })
  return { result: undefined }
}

async function runNativeHostGeneric(serviceWc, method, args) {
  const argsStr = args.map((a) => JSON.stringify(a)).join(', ')
  const result = await serviceWc.executeJavaScript(`
    new Promise((resolve, reject) => {
      try {
        if (typeof wx === 'undefined' || typeof wx[${JSON.stringify(method)}] !== 'function') {
          reject(new Error('wx.' + ${JSON.stringify(method)} + ' is not a function in service host'))
          return
        }
        resolve(wx.${method}(${argsStr}))
      } catch (e) { reject(e && e.message ? e.message : String(e)) }
    })
  `)
  return { result }
}

async function callWxMethod(method, args = [], appId) {
  const bridge = getBridge()
  const serviceWc = bridge.getServiceWc(appId)
  if (!serviceWc) throw new Error('[e2e] service host not connected')
  if (NAV_METHODS.has(method) || method === 'navigateBack') {
    return runNativeHostNav(bridge, serviceWc, method, args)
  }
  return runNativeHostGeneric(serviceWc, method, args)
}

// -- Project lifecycle ------------------------------------------------------
async function openProjectHook(projectPath, opts = {}) {
  const session = await runtime.openProject({ projectPath, ...opts })
  hostWindow.contentView.addChildView(session.view)
  session.setBounds({ x: 0, y: 0, width: WINDOW_WIDTH, height: WINDOW_HEIGHT })
  currentSession = session
  await session.ready
  return { appId: session.appInfo.appId, port: session.port }
}

async function closeProjectHook() {
  const session = currentSession
  if (!session) return
  await session.dispose()
  // Only clear the tracked session if nothing replaced it while we were
  // awaiting dispose() — an overlapping openProject() call in between would
  // have already made `session` stale (closeActiveSession no-ops on a stale
  // owner) and installed its own session as `currentSession`; clearing
  // unconditionally here would forget about that still-live session.
  if (currentSession === session) currentSession = null
}

/**
 * `runtime.setDevice()` alone only re-renders the DeviceShell bezel/notch (see
 * its doc comment in bridge-router.ts) — it does NOT live-update an already
 * running service host's `wx.getSystemInfoSync()` snapshot. devtools' own
 * `SimulatorChannel.SetDeviceInfo` main-process handler does that additionally
 * via `serviceWc.send('service-host:host-env:update', deviceInfoToHostEnv(device))`
 * (packages/devtools/src/main/ipc/simulator.ts) — that channel is consumed by
 * the service-host preload (build output shared with this package, see
 * build-assets.mjs) but the channel NAME itself isn't part of this package's
 * own exports, so it's replicated here as a literal (see
 * packages/devtools/src/shared/ipc-channels.ts's `ServiceHostChannel.HostEnvUpdate`
 * for the canonical definition). Test-only — does not change `runtime`'s
 * public behavior.
 */
function setDeviceHook(device) {
  runtime.setDevice(device)
  const bridge = globalThis.__diminaBridgeHandle
  const serviceWc = bridge?.getServiceWc()
  if (serviceWc && !serviceWc.isDestroyed()) {
    serviceWc.send('service-host:host-env:update', deviceInfoToHostEnv(device))
  }
}

/**
 * Simulate the user rotating the physical device: broadcasts DEVICE_CHANGE to every mounted DeviceShell via the runtime's public `setDevice()`, WITHOUT the direct `service-host:host-env:update` push `setDeviceHook` also does.
 *
 * That direct push (see setDeviceHook above) writes `deviceInfoToHostEnv(device)` straight into the running service host's snapshot — a raw overwrite that is page-orientation-UNAWARE (it derives windowWidth/windowHeight purely from the device's own orientation) and fires no dispatch/event at all.
 * That is fine for device-SIZE e2e (native-host-device.spec.ts, which never depends on per-page orientation), but wrong for page-orientation e2e: it would stomp a fixed-orientation page's snapshot with the naive device-only geometry, and it can never be the signal that gates `Page.onResize` / `wx.onWindowResize` dispatch because it never goes through DeviceShell's own dispatch-gated PAGE_RESIZE pipeline.
 * Orientation e2e needs the real wire: DEVICE_CHANGE -> DeviceShell recomputes effectiveOrientation from device + page state -> notifyResize -> main.
 */
function rotateDeviceHook(device) {
  runtime.setDevice(device)
}

globalThis.__diminaE2eHooks = {
  openProject: openProjectHook,
  closeProject: closeProjectHook,
  getCurrentPage,
  getPageStack,
  getServicePageRoutes,
  getPageData,
  callWxMethod,
  setDevice: setDeviceHook,
  rotateDevice: rotateDeviceHook,
}

})()
