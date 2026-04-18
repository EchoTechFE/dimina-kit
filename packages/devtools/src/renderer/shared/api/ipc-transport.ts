import type { IpcRenderer, IpcRendererEvent } from 'electron'

/**
 * The ONLY place in the renderer where we reach into `window.require('electron')`
 * to obtain `ipcRenderer`. Every typed facade in this directory funnels through
 * the helpers below so consumers never touch raw channel names or Electron types
 * themselves.
 */
function getIpcRenderer(): IpcRenderer {
  const mod = window.require('electron') as { ipcRenderer: IpcRenderer }
  return mod.ipcRenderer
}

/**
 * Typed wrapper for `ipcRenderer.invoke`. Swallows errors with a console warning
 * so callers can treat the result as `Promise<T | undefined>`-ish without boilerplate.
 */
export function invoke<T = void>(channel: string, ...args: unknown[]): Promise<T> {
  return getIpcRenderer()
    .invoke(channel, ...args)
    .catch((err: unknown) => {
      console.warn(`[ipc] ${channel} failed:`, err)
      return undefined as T
    })
}

/**
 * Strict variant of {@link invoke} that rejects on failure. Use when the caller
 * wants to handle the error explicitly (e.g. to show user-facing feedback).
 */
export function invokeStrict<T = void>(channel: string, ...args: unknown[]): Promise<T> {
  return getIpcRenderer().invoke(channel, ...args) as Promise<T>
}

/** Fire-and-forget one-way send. */
export function send(channel: string, ...args: unknown[]): void {
  getIpcRenderer().send(channel, ...args)
}

/**
 * Subscribe to a main → renderer event. Returns an unsubscribe function that
 * calls `removeListener` with the original handler.
 */
export function on<TArgs extends unknown[] = unknown[]>(
  channel: string,
  handler: (...args: TArgs) => void,
): () => void {
  const ipc = getIpcRenderer()
  const listener = (_event: IpcRendererEvent, ...args: unknown[]) => {
    handler(...(args as TArgs))
  }
  ipc.on(channel, listener)
  return () => {
    ipc.removeListener(channel, listener)
  }
}
