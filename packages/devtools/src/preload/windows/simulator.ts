// Default preload script for the simulator <webview>.
// Composes all built-in instrumentation. For custom preloads, import individual
// functions from '@dimina-kit/devtools/preload' and assemble your own.
//
// This file is bundled into a single JS file via build:preload (esbuild)
// because webview sandbox cannot resolve require() for separate modules.
import { installSimulatorBridge } from '../runtime/bridge.js'
import { installCustomApisBridge } from '../runtime/custom-apis.js'
import { installTempFileBridge } from '../runtime/temp-files.js'
import { installConsoleInstrumentation } from '../instrumentation/console.js'
import { createAppDataSource } from '../instrumentation/app-data.js'
import { createWxmlSource } from '../instrumentation/wxml.js'
import { createMiniappSnapshotHost } from '../miniapp-snapshot/host.js'
import { setupApiCompatHook } from '../shared/api-compat.js'
import { installNativeHostBridge } from '../runtime/native-host.js'

// Note: storage panel data is sourced from the main process via the CDP
// DOMStorage domain (src/main/services/simulator-storage). No preload-side
// localStorage hook is required.

// This bundle is registered as a `persist:simulator` SESSION frame preload, so
// under native-host it ALSO runs in the per-page render-host (`pageFrame.html`)
// and service-host (`service.html`) frames — which already carry their own
// dedicated preloads (DiminaRenderBridge / DiminaServiceBridge). Running the
// simulator instrumentation there is wrong AND harmful: `setupApiCompatHook`
// tries to redefine `document`, the snapshot host installs dead observers, and
// the bridges clobber the page realm those frames need. Bail out unless we're
// the actual simulator document. The default `<webview>` path always loads
// `simulator.html`, so it is never skipped — behaviour there is unchanged.
const __frameHref = (() => {
  try { return window.location?.href ?? '' } catch { return '' }
})()
const __isChildHostFrame =
  __frameHref.includes('pageFrame.html') || __frameHref.includes('/service.html')

if (!__isChildHostFrame) {
  setupApiCompatHook()
  installSimulatorBridge()
  installCustomApisBridge()
  installTempFileBridge()
  installConsoleInstrumentation()

  // Native-host render path (opt-in via DIMINA_NATIVE_HOST). Self-gating: it asks
  // main (sendSync) whether native-host is on and, if so, exposes
  // `window.__diminaNativeHost` so simulator/main.tsx boots the DeviceShell +
  // SimulatorMiniApp pipeline. A no-op when off, so the default path is untouched.
  installNativeHostBridge()

  // `installNativeHostBridge()` above exposes `window.__diminaNativeHost` only
  // when native-host is on. Under native-host the page DOM lives in child
  // render-host <webview> guests — not a same-document iframe reachable from this
  // preload — so the iframe-based WXML source would only ever publish null. Main
  // sources WXML instead (simulator-wxml service → SimulatorWxmlChannel); skip
  // the simulator-side source to avoid dead MutationObservers + null pushes.
  const nativeHostEnabled = window.__diminaNativeHost?.enabled === true

  const snapshotHost = createMiniappSnapshotHost()
  snapshotHost.register(createAppDataSource())
  if (!nativeHostEnabled) {
    snapshotHost.register(createWxmlSource())
  }
  snapshotHost.install()
}
