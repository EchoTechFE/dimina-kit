// E2E entry for native-host-custom-api.spec.ts: registers a simulator custom
// API via the package's PUBLIC `runtime.registerApi()` facade (the public
// equivalent of devtools' `launch({ onSetup })` / `instance.registerSimulatorApi`),
// so the spec can drive it from the simulator document via
// `window.__diminaCustomApis`.
//
// A dedicated minimal sibling of electron-entry.js rather than a flag on it:
// it only wires what THIS spec needs (openProject/closeProject) plus the
// custom-API registration under test, mirroring devtools' own precedent of a
// separate extension-host-entry.js for this exact scenario.
import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createElectronRuntime,
  registerElectronRuntimeSchemes,
} from '@dimina-kit/electron-runtime'
import { openProject as devkitOpenProject } from '@dimina-kit/devkit'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const WINDOW_WIDTH = 390
const WINDOW_HEIGHT = 844

// Same off-screen + focus-steal neutering as electron-entry.js (test-only;
// keeps the developer running the suite locally from losing focus).
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

// See electron-entry.js for why this is an async IIFE rather than top-level
// await (top-level await hangs app.whenReady() on this Electron/Node combo).
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
await hostWindow.loadURL('data:text/html,<title>dimina-electron-runtime e2e host (extension)</title>')

const runtime = await createElectronRuntime({
  hostWindow,
  adapter: { openProject: devkitOpenProject },
})

// Custom simulator API under test — the spec drives it via
// window.__diminaCustomApis.invoke('e2eEcho', ...) from inside the simulator
// document (see native-host-custom-api.spec.ts).
runtime.registerApi('e2eEcho', (params) => ({ echoed: params }))

let currentSession = null

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
  // See electron-entry.js's closeProjectHook for why this must be
  // identity-guarded rather than unconditional.
  if (currentSession === session) currentSession = null
}

globalThis.__diminaE2eHooks = {
  openProject: openProjectHook,
  closeProject: closeProjectHook,
}

})()
