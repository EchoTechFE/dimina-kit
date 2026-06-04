import { contextBridge } from 'electron'

/**
 * Expose `value` on the renderer's main world under `key`.
 *
 * Uses Electron's `contextBridge` only when `contextIsolation` is enabled
 * (the path that reaches the renderer's `window` through the isolated world).
 * When context isolation is OFF — e.g. the simulator/render-host/service-host
 * frames — `contextBridge.exposeInMainWorld` would always throw, so we skip it
 * entirely and assign `value` directly onto the preload realm's `window`.
 *
 * `process.contextIsolated` is Electron's renderer-side boolean for the current
 * frame: `true` when context isolation is on, `false` when it's off. (It is
 * `undefined` only in the main process, which never runs this preload helper.)
 *
 * Returns a disposer. It can only undo the direct-assignment path (a
 * `contextBridge` binding cannot be un-exposed); on the contextBridge path
 * the disposer is a no-op. The disposer never clobbers a `window[key]` that
 * something else has since reassigned.
 */
export function exposeOnMainWorld(key: string, value: unknown): () => void {
  let assignedToWindow = false

  if (process.contextIsolated) {
    // Isolated world (main / settings / view-manager host windows): the only
    // way to reach the renderer's `window` is via contextBridge. Keep the
    // defensive fallback + warn for the genuinely-unexpected failure case.
    try {
      contextBridge.exposeInMainWorld(key, value)
    }
    catch (err) {
      console.warn('[devtools/expose] contextBridge.exposeInMainWorld failed, falling back to direct window assignment:', err)
      ;(window as unknown as Record<string, unknown>)[key] = value
      assignedToWindow = true
    }
  }
  else {
    // Context isolation off (simulator <webview>, render-host, service-host):
    // contextBridge is unusable here and would always throw, so assign the
    // preload realm's `window` directly without the noisy failed attempt.
    ;(window as unknown as Record<string, unknown>)[key] = value
    assignedToWindow = true
  }

  return () => {
    if (!assignedToWindow) return
    const w = window as unknown as Record<string, unknown>
    if (w[key] === value) delete w[key]
  }
}
