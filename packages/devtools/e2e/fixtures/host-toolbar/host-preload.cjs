// Minimal HOST-owned toolbar preload for the R1 e2e.
//
// It deliberately does ONLY an unrelated thing — exposing a marker global to
// the toolbar page's main world — and does NOT install any size advertiser.
// Under the legacy design, handing this file to `setPreloadPath` REPLACED the
// built-in advertiser preload and the strip height collapsed to 0 (the real
// downstream incident R1 exists to fix). Under R1 the framework runtime is
// session-resident, so height advertising must keep working even though this
// preload knows nothing about it.
const { contextBridge } = require('electron')

try {
  contextBridge.exposeInMainWorld('__e2eHostPreloadMark', 'ran')
} catch (err) {
  // contextIsolation should be ON for the toolbar WCV; surface the failure in
  // the harness output instead of silently passing the anti-cheat probe.
  console.error('[host-preload.cjs] exposeInMainWorld failed:', err)
}
