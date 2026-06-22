/**
 * Ref-counted registration of the host-toolbar framework runtime on
 * `session.defaultSession`.
 *
 * The toolbar's height advertiser does not ride the toolbar WCV's
 * `webPreferences.preload`: a host's `setPreloadPath` would replace it and the
 * strip height would collapse to 0. Instead the runtime bundle
 * (`hostToolbarRuntimePreloadPath`) is registered once per process as a
 * session frame preload; its own guard (`--dimina-host-toolbar` marker +
 * `isMainFrame`) keeps it a zero-footprint no-op in every other defaultSession
 * renderer.
 *
 * Ref-counting: multiple ViewManagers can coexist in one
 * process and share the ONE defaultSession. Each manager acquires at most one
 * reference (on first toolbar need) and releases it in `disposeAll`. Only the
 * first acquire registers; only the last release unregisters (with the id
 * `registerPreloadScript` returned). After a full release a new acquire
 * re-registers — there is deliberately no "registered once ever" latch, so
 * dispose-everything-then-relaunch flows keep their toolbar runtime.
 *
 * Module-level state; tests reset it via `vi.resetModules()` + re-import.
 */

import { session } from 'electron'
import { hostToolbarRuntimePreloadPath } from '../../utils/paths.js'

let refCount = 0
let registrationId: string | null = null

/**
 * Take a reference on the shared session registration. Registers the runtime
 * preload on `session.defaultSession` when the count rises from zero. Call at
 * most once per ViewManager (the manager tracks its own acquired-flag).
 */
export function acquireHostToolbarSessionRuntime(): void {
  if (refCount === 0) {
    registrationId = session.defaultSession.registerPreloadScript({
      type: 'frame',
      filePath: hostToolbarRuntimePreloadPath,
    })
  }
  refCount++
}

/**
 * Release a reference. Unregisters (with the stored registration id) only when
 * the LAST reference is released; a still-alive ViewManager's toolbar keeps
 * its session runtime. Safe to call only by managers that actually acquired.
 */
export function releaseHostToolbarSessionRuntime(): void {
  if (refCount === 0) return
  refCount--
  if (refCount === 0 && registrationId !== null) {
    session.defaultSession.unregisterPreloadScript(registrationId)
    registrationId = null
  }
}
