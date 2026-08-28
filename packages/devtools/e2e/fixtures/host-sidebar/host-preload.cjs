// Minimal HOST-owned sidebar preload for the R1-parity e2e.
//
// Mirrors host-toolbar/host-preload.cjs: exposes only a marker global and
// installs NO advertiser, proving the session-resident width advertiser
// keeps working even though this preload knows nothing about it (the sidebar
// reuses the same session-runtime mechanism as the toolbar — see
// host-sidebar-session-runtime.ts).
const { contextBridge } = require('electron')

try {
  contextBridge.exposeInMainWorld('__e2eHostPreloadMark', 'ran')
} catch (err) {
  // contextIsolation should be ON for the sidebar WCV; surface the failure in
  // the harness output instead of silently passing the anti-cheat probe.
  console.error('[host-preload.cjs] exposeInMainWorld failed:', err)
}
