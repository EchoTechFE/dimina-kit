// E2E entry for the host-sidebar R1 spec (`host-sidebar.spec.ts`).
//
// Boots the stock workbench via `launch()` and exposes the app instance on
// `globalThis` so the spec can drive the host-sidebar control surface
// (`instance.context.views.hostSidebar` — setPreloadPath / loadFile) from the
// MAIN process via `electronApp.evaluate(...)`. Mirrors host-toolbar-entry.js
// on the inline (width) axis.
import electron from 'electron'
import { launch } from '../dist/main/api.js'

// Mirror host-toolbar-entry.js: keep windows off-screen under NODE_ENV=test
// so the e2e run doesn't steal focus.
if (process.env.NODE_ENV === 'test') {
  const hide = (win) => {
    try {
      win.setPosition(-2000, -2000)
      if (typeof win.blur === 'function') win.blur()
    } catch {}
  }
  electron.app.on('browser-window-created', (_e, win) => {
    try {
      win.once('ready-to-show', () => hide(win))
      win.on('show', () => hide(win))
    } catch {}
  })
}

launch({
  onSetup(instance) {
    globalThis.__e2eHostSidebarInstance = instance
  },
}).catch((err) => { console.error('[host-sidebar-entry] failed:', err) })
