// E2E entry for the host-toolbar R1 spec (`host-toolbar.spec.ts`).
//
// Boots the stock workbench via `launch()` and exposes the app instance on
// `globalThis` so the spec can drive the host-toolbar control surface
// (`instance.context.views.hostToolbar` — setPreloadPath / loadFile) from the
// MAIN process via `electronApp.evaluate(...)`. Driving it from the spec (not
// from onSetup) lets the spec sequence "open project first, then load toolbar
// content", which makes the height-advertise → placeholder loop deterministic.
import electron from 'electron'
import { launch } from '../dist/main/api.js'

// Mirror extension-host-entry.js: keep windows off-screen under NODE_ENV=test
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
    globalThis.__e2eHostToolbarInstance = instance
  },
}).catch((err) => { console.error('[host-toolbar-entry] failed:', err) })
