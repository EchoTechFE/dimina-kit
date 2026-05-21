import { contextBridge } from 'electron'

/**
 * Expose `value` on the renderer's main world under `key`.
 *
 * Prefers Electron's `contextBridge` (the path that works with
 * `contextIsolation: true`). When `contextBridge` is unavailable — e.g. a
 * webview running without context isolation — it falls back to assigning
 * `value` directly onto the preload realm's `window`.
 *
 * Returns a disposer. It can only undo the fallback assignment (a
 * `contextBridge` binding cannot be un-exposed); on the contextBridge path
 * the disposer is a no-op. The disposer never clobbers a `window[key]` that
 * something else has since reassigned.
 */
export function exposeOnMainWorld(key: string, value: unknown): () => void {
  let fellBack = false
  try {
    contextBridge.exposeInMainWorld(key, value)
  }
  catch {
    ;(window as unknown as Record<string, unknown>)[key] = value
    fellBack = true
  }
  return () => {
    if (!fellBack) return
    const w = window as unknown as Record<string, unknown>
    if (w[key] === value) delete w[key]
  }
}
