// E2E entry for the dialog z-order regression spec (`dialog-zorder.spec.ts`).
//
// Boots the stock workbench with NO update checker configured — the update
// dialog is triggered directly via `instance.context.views.showUpdateDialog(...)`
// from the spec (the same production call `view-manager-dialog-zorder.test.ts`
// mocks), not via the periodic GitHub check, so the trigger is deterministic
// and network-independent. Exposes the app instance on `globalThis` so the
// spec can drive it from the MAIN process via `electronApp.evaluate(...)`.
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
    globalThis.__e2eDialogZorderInstance = instance
  },
}).catch((err) => { console.error('[dialog-zorder-entry] failed:', err) })
