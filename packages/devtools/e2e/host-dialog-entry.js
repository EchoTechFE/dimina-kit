// E2E entry for the host-dialog spec (`host-dialog.spec.ts`).
//
// Boots the stock workbench via `launch()` and exposes the app instance on
// `globalThis` so the spec can drive the host-dialog control surface
// (`instance.context.views.hostDialog` — loadFile / show / hide) from the
// MAIN process via `electronApp.evaluate(...)`. Mirrors host-toolbar-entry.js;
// the dialog needs no project open (it is a by-demand, main-window-centered
// overlay independent of either app screen).
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
    globalThis.__e2eHostDialogInstance = instance
  },
}).catch((err) => { console.error('[host-dialog-entry] failed:', err) })
