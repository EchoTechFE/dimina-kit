import { useCallback, useEffect, useRef } from 'react'
import { createViewAnchor } from './view-anchor.js'
import type { Bounds, ViewAnchorHandle, ViewAnchorOptions } from './types.js'

/**
 * React adapter over the imperative `createViewAnchor` core.
 *
 * (React lint forces the `use` prefix on any hook returning a ref
 * callback; the library's identity is still the `ViewAnchor` core — this is
 * just the React binding.)
 */
export interface UseViewAnchorOptions extends ViewAnchorOptions {
  /**
   * Non-DOM dependencies that move the target's rect and must force a
   * re-publish (layout signature, project path, a tab toggle's
   * `display:none`, …). A `ResizeObserver` covers pure geometry; `deps`
   * covers state it cannot see. Keep the array length stable across
   * renders (React effect-deps rule).
   */
  deps?: ReadonlyArray<unknown>
}

export type ViewAnchorRef = (el: HTMLElement | null) => void

/**
 * Bind a native view's bounds to whichever DOM element the returned ref
 * callback is attached to. On attach → `createViewAnchor(el, opts)`; on
 * detach (`null`) → publish ZERO then `dispose()`; on `opts`/`deps` change →
 * `update`; on unmount → publish ZERO then `dispose`.
 *
 * Why ZERO on disappearance (P1 fix): the anchor's follower is a *main-process*
 * `WebContentsView`, not a DOM node. When the anchored element vanishes, core
 * `dispose()` only stops observing — it deliberately never publishes again
 * (its Contract 6/7). But the host only collapses the native view when it
 * receives `{0,0,0,0}` (isHidden). In production the debug cell is *unmounted*
 * (not `display:none`) when hidden, so the ref goes to `null` and the native
 * DevTools view would otherwise stay frozen at its last bounds, floating on
 * top and occluding content. So the adapter (not core) must emit one ZERO via
 * the already-tested `update({ present:false })` path before disposing.
 */
export function useViewAnchor(opts: UseViewAnchorOptions): ViewAnchorRef {
  const handleRef = useRef<ViewAnchorHandle | null>(null)
  const elRef = useRef<HTMLElement | null>(null)
  // Latest opts, read by the stable ref callback when it creates the anchor.
  // Synced render-synchronously (NOT in an effect): the ref callback reads
  // `optsRef.current` during *commit* (when the element attaches), which runs
  // before passive effects. An effect-synced ref would be one render stale at
  // that point, so a hidden→shown remount (`present` flips false→true together
  // with the element re-mounting, exactly what the debug cell does) would
  // create the anchor with the old `present:false` and emit a spurious ZERO
  // before the real rect. A render write keeps it current at commit, and is
  // idempotent under StrictMode's double render.
  const optsRef = useRef(opts)
  // eslint-disable-next-line react-hooks/refs -- see above: must be current at commit, before effects run
  optsRef.current = opts

  // Baseline for the re-apply effect's change detection. Declared here (before
  // the ref callback) so the callback can re-seed it on (re)create.
  const appliedRef = useRef<ReadonlyArray<unknown>>([
    opts.present,
    opts.publish,
    ...(opts.deps ?? []),
  ])

  // Collapse the native view (publish ZERO) and tear the anchor down. Reuse
  // the existing, tested `update({ present:false })` path: it synchronously
  // publishes `{0,0,0,0}` and stops observing (core Contract 5), then
  // `dispose()` makes the anchor inert. Idempotent via the `handleRef.current`
  // null-check so the two callers below can never double-emit ZERO.
  const collapseAndDispose = useRef((): void => {
    const handle = handleRef.current
    if (!handle) return
    handle.update({ present: false, publish: optsRef.current.publish })
    handle.dispose()
    handleRef.current = null
  })

  const ref = useCallback<ViewAnchorRef>((el) => {
    if (el === elRef.current) return
    elRef.current = el
    if (handleRef.current) {
      if (el) {
        // Swapping to *another* live element: dispose the old anchor without a
        // ZERO. The new element publishes its real rect immediately below, so
        // a transient ZERO between the two would only cause a needless
        // detach/re-attach flicker of the native view.
        handleRef.current.dispose()
        handleRef.current = null
      } else {
        // Element detached (ref → null): the anchor point is gone, so collapse
        // the native view (one ZERO) before disposing.
        collapseAndDispose.current()
      }
    }
    if (el) {
      handleRef.current = createViewAnchor(el, {
        present: optsRef.current.present,
        publish: optsRef.current.publish,
      })
      // The anchor was just created at the current (present, publish, deps), so
      // seed the re-apply baseline to match. Otherwise the post-commit re-apply
      // effect would see this fresh state as a change and publish a second time
      // — on a remount with a changed `present` that is a double-emit.
      appliedRef.current = [
        optsRef.current.present,
        optsRef.current.publish,
        ...(optsRef.current.deps ?? []),
      ]
    }
  }, [])

  // Re-apply on opts/deps change. We must `update` whenever the
  // (present, publish, …deps) tuple actually changes, but NOT on the mount run
  // (the ref callback already created the anchor and published once) and NOT on
  // a StrictMode replay (dev double-fires this effect's setup with the *same*
  // tuple — a blind `update` then re-publishes the mount rect a second time).
  // So instead of guessing "is this the first run?", compare against the
  // last-applied tuple and apply only on a genuine change. The tuple is seeded
  // with the mount opts, so the mount run and its StrictMode replay both see
  // "unchanged" and skip — idempotent by construction. `deps` keeps a stable
  // length across renders (documented above), so positional compare is sound.
  useEffect(() => {
    const next: ReadonlyArray<unknown> = [
      opts.present,
      opts.publish,
      ...(opts.deps ?? []),
    ]
    const prev = appliedRef.current
    const changed =
      next.length !== prev.length || next.some((v, i) => !Object.is(v, prev[i]))
    if (!changed) return
    appliedRef.current = next
    handleRef.current?.update({ present: opts.present, publish: opts.publish })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.present, opts.publish, ...(opts.deps ?? [])])

  // Collapse the native view + dispose on teardown.
  //
  // StrictMode-safe lifecycle: this effect's setup/cleanup is double-fired in
  // dev (setup → cleanup → setup). The anchor itself is created/owned by the
  // ref callback, which in React 18 fires exactly once on mount and once with
  // `null` on a real detach — it is NOT replayed by StrictMode. So this effect
  // must not destroy the ref-owned anchor on a *throwaway* unmount, or the
  // re-setup would have nothing to restore.
  //
  // Discriminator: on a real teardown React detaches the element first
  // (`ref(null)` → `elRef.current === null`, and that path already emitted the
  // single ZERO + disposed); on a StrictMode throwaway unmount the element is
  // still attached (`elRef.current !== null`, ref never fired `null`). So we
  // only collapse here when the element is genuinely gone, and otherwise leave
  // the live anchor intact for the immediate re-setup.
  //
  // The setup re-establishes the anchor if a prior cleanup ever tore it down
  // while the element is still attached, keeping setup/cleanup symmetric.
  useEffect(() => {
    const collapse = collapseAndDispose.current
    if (elRef.current && !handleRef.current) {
      handleRef.current = createViewAnchor(elRef.current, {
        present: optsRef.current.present,
        publish: optsRef.current.publish,
      })
    }
    return () => {
      if (elRef.current === null) collapse()
    }
  }, [])

  return ref
}

export type { Bounds }
