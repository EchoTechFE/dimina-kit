// E2E entry exercising the downstream-host extension path:
// `workbench({ headerHeight, onSetup })` injecting a custom toolbar
// action and a simulator custom API. The companion spec
// (`extension-host.spec.ts`) drives this entry and asserts the injected
// extensions actually run.
import electron from 'electron'
import fs from 'node:fs'
import { workbench } from '../dist/main/api.js'

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

workbench({
  // Non-default header height — the spec measures the rendered toolbar header
  // element to prove this config reaches the renderer (default is 40).
  headerHeight: 72,
  onSetup(instance) {
    // Custom toolbar action. The handler writes a sentinel file so the spec
    // can prove the click reached this host-registered handler — the path is
    // supplied by the spec via DIMINA_E2E_TOOLBAR_SENTINEL.
    instance.toolbar.set([
      {
        id: 'e2e-action',
        label: 'E2E_TOOLBAR_ACTION',
        handler: () => {
          const sentinel = process.env.DIMINA_E2E_TOOLBAR_SENTINEL
          if (sentinel) {
            fs.writeFileSync(sentinel, 'e2e-action:invoked', 'utf8')
          }
        },
      },
    ])

    // Simulator custom API — the simulated mini-program reaches it as
    // `wx.e2eEcho(...)`; the spec triggers it through the custom-apis bridge.
    instance.registerSimulatorApi('e2eEcho', (params) => ({ echoed: params }))
  },
}).catch((err) => { console.error('[extension-host-entry] failed:', err) })
