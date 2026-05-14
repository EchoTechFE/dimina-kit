/**
 * Preload bridge for the main window, settings window, settings overlay
 * view, and popover overlay view. Exposes a minimal, typed `window.devtools`
 * surface so the renderer never has to call `window.require('electron')`.
 *
 * This file is bundled by esbuild to CJS at `dist/preload/windows/main.js`
 * (see package.json `build:preload`). It must remain a leaf module — do
 * NOT import other preload files via `.js` ESM specifiers; everything goes
 * through the Electron `contextBridge` / `ipcRenderer` runtime.
 *
 * Channel governance lives in the main process: `sender-policy.ts` plus the
 * per-handler zod schemas decide what's accepted. The preload layer is a
 * thin pass-through — a renderer inventing channel names will just hit a
 * main-side rejection, so duplicating an allowlist here added no real
 * defense for a devtool that loads user-trusted mini-programs.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

const api = {
  ipc: {
    invoke: (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args),
    send: (channel: string, ...args: unknown[]) => {
      ipcRenderer.send(channel, ...args)
    },
    on: (
      channel: string,
      listener: (event: IpcRendererEvent, ...args: unknown[]) => void,
    ) => {
      ipcRenderer.on(channel, listener)
      return () => ipcRenderer.removeListener(channel, listener)
    },
    once: (
      channel: string,
      listener: (event: IpcRendererEvent, ...args: unknown[]) => void,
    ) => {
      ipcRenderer.once(channel, listener)
    },
    removeListener: (
      channel: string,
      listener: (...args: unknown[]) => void,
    ) => {
      ipcRenderer.removeListener(channel, listener)
    },
  },
}

// All host windows that load this preload run with `contextIsolation: true`
// (main / settings / view-manager), so `contextBridge` is the path that
// reaches the renderer's `window`. The simulator <webview> uses a separate
// preload (`simulator.ts`).
contextBridge.exposeInMainWorld('devtools', api)

// Test-only hatch: e2e helpers emit synthetic IPC events on the renderer's
// ipcRenderer instance to trigger handlers registered via `devtools.ipc.on`
// without round-tripping through the main process. Gated on NODE_ENV so
// production builds never expose it.
if (process.env.NODE_ENV === 'test') {
  contextBridge.exposeInMainWorld('__testIpc', {
    emit: (channel: string, ...args: unknown[]) => {
      ;(ipcRenderer as unknown as { emit: (c: string, ...a: unknown[]) => void }).emit(channel, ...args)
    },
  })
}

export type DevtoolsApi = typeof api
