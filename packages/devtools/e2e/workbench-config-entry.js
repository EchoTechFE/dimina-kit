// E2E entry that boots the app through the declarative `workbench(config)`
// host-shell entry (NOT the default `launch()` path) — proving the new entry
// drives the real devtools runtime end-to-end in Electron. Mirrors
// electron-entry.js's off-screen window handling.
import electron from 'electron'

import { defineEvent } from '@dimina-kit/workbench'
import { workbench } from '../dist/main/app/workbench-entry.js'

if (process.env.NODE_ENV === 'test') {
  const moveOffscreen = (win) => {
    try {
      win.setPosition(-2000, -2000)
      if (typeof win.blur === 'function') win.blur()
    } catch {}
  }
  electron.app.on('browser-window-created', (_e, win) => {
    try {
      win.once('ready-to-show', () => moveOffscreen(win))
      win.on('show', () => moveOffscreen(win))
      win.on('focus', () => {
        try { win.blur() } catch {}
      })
    } catch {}
  })
}

const authChanged = defineEvent('authChanged')

// IMPORTANT: do NOT top-level-`await workbench()` in an ESM main. Electron does
// not fire `app.whenReady()` until the main module finishes evaluating, and
// `workbench()` awaits `whenReady` internally — awaiting it here would deadlock.
// Fire-and-forget (the default `index.ts` calls `launch()` the same way); the
// Electron event loop keeps the process alive and `setup(runtime)` still runs.
workbench({
  app: { name: 'QDMP Test Host' },
  simulatorApis: {
    hostPing: async () => 'pong',
  },
  hostServices: {
    getUser: async () => ({ id: 'u1' }),
  },
  events: [authChanged],
  setup: async (runtime) => {
    // Invoke the config-declared simulator API through the runtime facade to
    // prove the contribution actually wired into the devtools registry.
    let simulatorPing = null
    try {
      simulatorPing = await runtime.call.simulator('hostPing')
    }
    catch (e) {
      simulatorPing = `ERR:${String(e)}`
    }
    // Observable proof that setup(runtime) ran with a real facade, for the spec
    // to read via electronApp.evaluate(() => globalThis.__workbenchE2E).
    globalThis.__workbenchE2E = {
      setupRan: true,
      hasContext: typeof runtime.context === 'object' && runtime.context !== null,
      hasWorkspace: typeof runtime.context?.workspace === 'object',
      activeProjectPath: runtime.context?.workspace?.activeProjectPath ?? null,
      hasElectronApp: !!runtime.electron?.app,
      hasMainWindow: !!runtime.mainWindow,
      simulatorPing,
    }
  },
}).catch((err) => {
  console.error('[workbench-config-entry] workbench() failed:', err)
})
