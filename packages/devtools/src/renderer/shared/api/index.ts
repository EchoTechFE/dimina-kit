/**
 * Typed facade over Electron IPC for the renderer. Consumers (hooks,
 * components, entry files) import everything from `@/shared/api` and must
 * never reach into `window.require('electron')` or call `ipcRenderer.*`
 * directly — the sole allowed touchpoint is `./ipc-transport.ts`.
 */

export * from './app-api'
export * from './project-api'
export * from './view-api'
export * from './settings-api'
export * from './simulator-api'
