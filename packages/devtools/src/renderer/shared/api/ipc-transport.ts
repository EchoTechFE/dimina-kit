import type { IpcRendererEvent } from 'electron'

/**
 * The ONLY place in the renderer where we reach into the preload-injected
 * `window.devtools.ipc` bridge. Every typed facade in this directory funnels
 * through the helpers below so consumers never touch raw channel names or
 * Electron types themselves.
 *
 * If this throws, the preload script failed to load — check that the
 * BrowserWindow / WebContentsView was created with the correct
 * `webPreferences.preload` (see `src/main/utils/paths.ts#mainPreloadPath`).
 */
function getIpc(): Window['devtools']['ipc'] {
  // This is the single sanctioned site that may reach into the raw preload
  // bridge; every renderer import path must go through the helpers below.
  // eslint-disable-next-line no-restricted-syntax
  const ipc = window.devtools?.ipc
  if (!ipc) {
    throw new Error('[devtools] preload bridge missing; check webPreferences.preload')
  }
  return ipc
}

/**
 * Typed wrapper for `ipcRenderer.invoke`. Swallows errors with a console warning
 * so callers can treat the result as `Promise<T | undefined>`-ish without boilerplate.
 */
export function invoke<T = void>(channel: string, ...args: unknown[]): Promise<T> {
  return getIpc()
    .invoke<T>(channel, ...args)
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
  return getIpc().invoke<T>(channel, ...args)
}

/** Fire-and-forget one-way send. */
export function send(channel: string, ...args: unknown[]): void {
  getIpc().send(channel, ...args)
}

/**
 * Subscribe to a main → renderer event. Returns an unsubscribe function that
 * calls `removeListener` with the original handler.
 */
export function on<TArgs extends unknown[] = unknown[]>(
  channel: string,
  handler: (...args: TArgs) => void,
): () => void {
  const ipc = getIpc()
  const listener = (_event: IpcRendererEvent, ...args: unknown[]) => {
    handler(...(args as TArgs))
  }
  return ipc.on(channel, listener)
}
