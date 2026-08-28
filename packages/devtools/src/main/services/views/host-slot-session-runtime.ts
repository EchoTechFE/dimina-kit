/**
 * Ref-counted registration of a downstream-host-slot framework runtime on
 * `session.defaultSession`.
 *
 * A slot's size advertiser does not ride the slot WCV's `webPreferences.preload`:
 * a host's `setPreloadPath` would replace it and the reserved strip/pane would
 * collapse to 0. Instead the runtime bundle is registered once per process as a
 * session frame preload; its own guard (an `additionalArguments` marker +
 * `isMainFrame`) keeps it a zero-footprint no-op in every other defaultSession
 * renderer.
 *
 * Ref-counting: multiple ViewManagers can coexist in one process and share the
 * ONE defaultSession. Each manager acquires at most one reference (on first
 * slot need) and releases it in `disposeAll`. Only the first acquire registers;
 * only the last release unregisters (with the id `registerPreloadScript`
 * returned). After a full release a new acquire re-registers — there is
 * deliberately no "registered once ever" latch, so dispose-everything-then-
 * relaunch flows keep their slot runtime.
 *
 * Each `createHostSlotSessionRuntime(preloadPath)` call owns its own
 * independent ref-count closure (one instance per slot TYPE, e.g. toolbar vs.
 * sidebar), never a cross-slot shared counter. Module-level state per call site
 * that binds one; tests reset it via `vi.resetModules()` + re-import.
 */

import { session } from 'electron'

export interface HostSlotSessionRuntime {
  /**
   * Take a reference on the shared session registration. Registers the runtime
   * preload on `session.defaultSession` when the count rises from zero. Call at
   * most once per ViewManager (the manager tracks its own acquired-flag).
   */
  acquire(): void
  /**
   * Release a reference. Unregisters (with the stored registration id) only when
   * the LAST reference is released; a still-alive ViewManager's slot keeps its
   * session runtime. Safe to call only by managers that actually acquired.
   */
  release(): void
}

export function createHostSlotSessionRuntime(preloadPath: string): HostSlotSessionRuntime {
  let refCount = 0
  let registrationId: string | null = null

  return {
    acquire(): void {
      if (refCount === 0) {
        registrationId = session.defaultSession.registerPreloadScript({
          type: 'frame',
          filePath: preloadPath,
        })
      }
      refCount++
    },
    release(): void {
      if (refCount === 0) return
      refCount--
      if (refCount === 0 && registrationId !== null) {
        session.defaultSession.unregisterPreloadScript(registrationId)
        registrationId = null
      }
    },
  }
}
