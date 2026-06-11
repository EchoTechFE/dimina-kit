// E2E entry exercising the downstream-host extension path:
// `launch({ headerHeight, onSetup })` injecting a simulator custom API.
// The companion spec (`extension-host.spec.ts`) drives this entry and
// asserts the injected extension actually runs.
//
// NOTE: `instance.toolbar.set()` (host-injected toolbar buttons) is
// decommissioned — this entry must NOT call it. With the surface deleted,
// `instance.toolbar` is undefined and a leftover call would TypeError and
// kill the whole launch (and with it every test in the suite).
import electron from 'electron'
import { launch } from '../dist/main/api.js'

// Mirror update-entry.js: keep windows off-screen under NODE_ENV=test so the
// e2e run doesn't steal focus.
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
  // Deprecated, runtime-ignored config — kept on purpose to prove a host
  // still passing `headerHeight` doesn't crash launch. The spec asserts the
  // toolbar header stays at the fixed 40px despite this 72.
  headerHeight: 72,
  onSetup(instance) {
    // Simulator custom API — the simulated mini-program reaches it as
    // `wx.e2eEcho(...)`; the spec triggers it through the custom-apis bridge.
    instance.registerSimulatorApi('e2eEcho', (params) => ({ echoed: params }))
  },
}).catch((err) => { console.error('[extension-host-entry] failed:', err) })
