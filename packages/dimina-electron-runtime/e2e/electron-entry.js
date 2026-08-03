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

async function runNativeHostNav(bridge, serviceWc, method, args) {
  const arg = method === 'navigateBack' ? (args[0] ?? { delta: 1 }) : (args[0] ?? {})
  const since = bridge.getActiveBridgeId()
  await serviceWc.executeJavaScript(`wx.${method}(${JSON.stringify(arg)})`)
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

globalThis.__diminaE2eHooks = {
  openProject: openProjectHook,
  closeProject: closeProjectHook,
  getCurrentPage,
  getPageStack,
  getPageData,
  callWxMethod,
  setDevice: setDeviceHook,
}

})()
