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
import { setupApiCompatHook } from '../shared/api-compat.js'
import { installNativeHostBridge } from '../runtime/native-host.js'

// Note: storage panel data is sourced from the main process via the CDP
// DOMStorage domain (src/main/services/simulator-storage). No preload-side
// localStorage hook is required.

// This bundle is assigned to the native-host simulator WebContentsView only, so
// it always runs in the actual simulator document (`simulator.html`) — never a
// per-page render-host (`pageFrame.html`) or service-host (`service.html`)
// frame, which carry their own dedicated preloads.
setupApiCompatHook()
installSimulatorBridge()
installCustomApisBridge()
installTempFileBridge()
installConsoleInstrumentation()

// Native-host render path: self-gating bridge that exposes
// `window.__diminaNativeHost` so simulator/main.tsx boots the DeviceShell +
// SimulatorMiniApp pipeline.
installNativeHostBridge()

// AppData instrumentation source. We call its `start()` DIRECTLY (not wrapped
// in a MiniappSnapshotHost) purely for the automation-surface side effects: it
// installs `window.__simulatorHook.appData` and mirrors the flat cache into the
// `window.__simulatorData.getAppdata()` surface — both still read in the
// simulator (top) frame by automation `getData` (handlers/page.ts), the MCP
// context overview (mcp/tools/context-tools.ts) and the e2e automator helper.
//
// We do NOT wrap it in a host: the host's `miniapp-snapshot:push/pull` IPC has
// no consumer under native-host (the renderer reads panel WXML/AppData from
// main via SimulatorWxmlChannel / SimulatorAppDataChannel), so install()'s
// publish would only ever fire into the void. We also do NOT register
// `createWxmlSource` — under native-host the page DOM lives in child
// render-host <webview> guests, so a top-frame DOM observer would only publish
// null. (`createWxmlSource` / `createMiniappSnapshotHost` stay exported from
// `@dimina-kit/devtools/preload` for external/composed preloads.)
createAppDataSource().start(() => {})
