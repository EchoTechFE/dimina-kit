/**
 * Public preload API surface for `@dimina-kit/devtools/preload`.
 *
 * External consumers compose their own simulator <webview> preload by
 * importing the `install*` helpers from here. The built-in simulator
 * preload at `windows/simulator.ts` is one such composition.
 *
 * NOTE: do NOT add main-window preload concerns (contextBridge / ipc
 * exposure) to this file — that lives in `windows/main.ts` and is
 * bundled by esbuild, never re-exported through this barrel.
 */
export { installConsoleInstrumentation } from './instrumentation/console.js'
export { createAppDataSource } from './instrumentation/app-data.js'
export type { AppDataSnapshot } from './instrumentation/app-data.js'
export { createWxmlSource } from './instrumentation/wxml.js'
export { createMiniappSnapshotHost } from './miniapp-snapshot/host.js'
export type {
  MiniappSnapshotHost,
  MiniappSnapshotSource,
  SnapshotEnvelope,
  SnapshotSourceId,
} from './miniapp-snapshot/types.js'
export { installSimulatorBridge } from './runtime/bridge.js'
export { installCustomApisBridge } from './runtime/custom-apis.js'
export type { DiminaCustomApisBridge } from './runtime/custom-apis.js'
// NATIVE-HOST: lets a custom simulator preload opt into the native-host bridge
// (DeviceShell render path) the same way the built-in `windows/simulator.ts`
// does. Self-gating — a no-op disposer when native-host is off. Required so
// external/composed preloads aren't stranded once native-host becomes the sole
// runtime. (Stage-0 prerequisite for decommissioning the default path.)
export { installNativeHostBridge } from './runtime/native-host.js'
export type { DiminaNativeHostBridge } from './runtime/native-host.js'
export { setupApiCompatHook } from './shared/api-compat.js'
