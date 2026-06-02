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

  // Native-host render path: self-gating bridge that exposes
  // `window.__diminaNativeHost` so simulator/main.tsx boots the DeviceShell +
  // SimulatorMiniApp pipeline.
  installNativeHostBridge()

  // AppData instrumentation source. Its `start()` installs the
  // `window.__simulatorHook.appData` hook and mirrors the flat cache into the
  // `window.__simulatorData.getAppdata()` automation surface — both still read
  // in the simulator (top) frame by automation `getData` (handlers/page.ts),
  // the MCP context overview (mcp/tools/context-tools.ts) and the e2e automator
  // helper. The panel-facing WXML/AppData *snapshots* come from main instead
  // (simulator-wxml / simulator-appdata services → SimulatorWxmlChannel /
  // SimulatorAppDataChannel), so we deliberately do NOT register
  // `createWxmlSource` here — under native-host the page DOM lives in child
  // render-host <webview> guests, so a top-frame DOM observer would only ever
  // publish null. (`createWxmlSource` / `createMiniappSnapshotHost` stay
  // exported from `@dimina-kit/devtools/preload` for external/composed preloads.)
  const snapshotHost = createMiniappSnapshotHost()
  snapshotHost.register(createAppDataSource())
  snapshotHost.install()
}
