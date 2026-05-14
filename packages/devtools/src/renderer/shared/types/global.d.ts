/**
 * Ambient type declarations for the renderer global surface exposed by the
 * main-window preload (`src/preload/windows/main.ts`).
 *
 * The renderer must never reach into `window.require('electron')`; every
 * IPC call funnels through `window.devtools.ipc` and is brokered by
 * `src/renderer/shared/api/ipc-transport.ts`.
 */
import type { IpcRendererEvent } from 'electron'

declare global {
  interface Window {
    devtools: {
      ipc: {
        invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>
        send(channel: string, ...args: unknown[]): void
        on(
          channel: string,
          listener: (event: IpcRendererEvent, ...args: unknown[]) => void,
        ): () => void
        once(
          channel: string,
          listener: (event: IpcRendererEvent, ...args: unknown[]) => void,
        ): void
        removeListener(
          channel: string,
          listener: (...args: unknown[]) => void,
        ): void
      }
    }
  }
}

export {}
