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
export { installAppDataInstrumentation, sendAllAppData } from './instrumentation/app-data.js'
export { installWxmlInstrumentation, sendWxmlTree, setupWxmlObserver } from './instrumentation/wxml.js'
export { installSimulatorBridge } from './runtime/bridge.js'
export { setupApiCompatHook } from './shared/api-compat.js'
