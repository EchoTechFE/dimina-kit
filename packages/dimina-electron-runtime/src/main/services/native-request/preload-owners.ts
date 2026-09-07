import type { WebContents } from 'electron'
import type { NativeRequestService } from './types.js'

type RequestOwner = Pick<WebContents, 'id' | 'once' | 'removeListener' | 'isDestroyed'>

/** The router owns these listeners; its callers' WebContents can outlive it. */
export function createPreloadRequestOwners(service: NativeRequestService) {
  const listeners = new Map<RequestOwner, () => void>()
  let disposed = false
  return {
    ensure(wc: RequestOwner): void {
      if (disposed || listeners.has(wc)) return
      const onDestroyed = () => {
        listeners.delete(wc)
        service.disposeOwner(`preload:${wc.id}`)
      }
      listeners.set(wc, onDestroyed)
      wc.once('destroyed', onDestroyed)
    },
    dispose(): void {
      disposed = true
      // Snapshot and detach before any abort observer can re-enter.
      const retired = Array.from(listeners)
      listeners.clear()
      for (const [wc, listener] of retired) {
        if (!wc.isDestroyed()) wc.removeListener('destroyed', listener)
        service.disposeOwner(`preload:${wc.id}`)
      }
    },
  }
}
