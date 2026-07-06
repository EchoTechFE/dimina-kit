import type { DesiredView, PlacementSnapshot } from '../layout/index.js'

// Renderer-side single source of truth for native-view placement. Every anchor
// writes its view's desired placement here instead of invoking IPC directly; a
// central scheduler reads the WHOLE table once per animation frame and publishes
// one window-level snapshot (a monotonic epoch shared by all views in the tick).
//
// Coalescing a level stream is safe: many set()/remove() calls in one frame
// collapse to the latest level, so a transient (e.g. a relayout that momentarily
// measures 0×0 then restores) is overwritten before it is ever published. This
// is what a per-view edge stream cannot do — it is the producer half of the
// reconcile design (see ../layout/placement-reconcile.ts).

export interface PlacementPublisherDeps<Extra = unknown> {
  // Renderer lifetime id stamped on every snapshot; a fresh renderer uses a
  // higher generation so the main reconciler resets its table. A function is
  // re-read on EVERY flush, so a host whose generation is assigned by main (via a
  // grant that can arrive after the publisher is created) can hand a getter and
  // have later snapshots pick up the newer value.
  generation: number | (() => number)
  publish: (snapshot: PlacementSnapshot<Extra>) => void
  // Injectable for tests; default to requestAnimationFrame / cancelAnimationFrame.
  requestFrame?: (cb: () => void) => number
  cancelFrame?: (id: number) => void
}

export interface PlacementPublisher<Extra = unknown> {
  // Upsert one view's desired placement and schedule a coalesced publish.
  set(view: DesiredView<Extra>): void
  // Drop a view from the desired table and schedule a coalesced publish.
  remove(viewId: string): void
  // End this source of truth: cancel any pending frame and synchronously
  // publish one final EMPTY snapshot (the death of the publisher is itself a
  // level — nothing is desired), so a level-triggered consumer releases every
  // view this publisher placed. Idempotent; set()/remove() are no-ops after.
  dispose(): void
}

export function createPlacementPublisher<Extra = unknown>(
  deps: PlacementPublisherDeps<Extra>,
): PlacementPublisher<Extra> {
  const requestFrame =
    deps.requestFrame ?? ((cb: () => void): number => requestAnimationFrame(cb))
  const cancelFrame = deps.cancelFrame ?? ((id: number): void => cancelAnimationFrame(id))
  const readGeneration =
    typeof deps.generation === 'function' ? deps.generation : (): number => deps.generation as number

  const views = new Map<string, DesiredView<Extra>>()
  let dirty = false
  let frameId: number | null = null
  let epoch = 0
  let disposed = false

  function schedule(): void {
    if (disposed || frameId !== null) return
    frameId = requestFrame(flush)
  }

  function flush(): void {
    frameId = null
    // A frame that fires with nothing dirty (or after dispose) publishes
    // nothing — coalescing means only a real change reaches the wire.
    if (disposed || !dirty) return
    dirty = false
    deps.publish({
      generation: readGeneration(),
      epoch: epoch++,
      views: [...views.values()],
    })
  }

  return {
    set(view: DesiredView<Extra>): void {
      if (disposed) return
      views.set(view.viewId, view)
      dirty = true
      schedule()
    },
    remove(viewId: string): void {
      if (disposed) return
      // Removing an absent id is not a change — don't arm a redundant frame.
      if (!views.delete(viewId)) return
      dirty = true
      schedule()
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      if (frameId !== null) {
        cancelFrame(frameId)
        frameId = null
      }
      // The publisher is the renderer-side source of truth for desired
      // placement, and the main-side reconciler is level-triggered: it keeps
      // applying whatever level it last received. The source of truth dying is
      // itself a level — nothing is desired anymore — so flush one final empty
      // snapshot synchronously. Without it the last non-empty snapshot stays
      // frozen in main and every view it placed survives its owner (e.g. a
      // host toolbar strip overlaying the page that replaces the unmounted
      // one). The epoch stays monotonic so the reconciler can't reject the
      // flush as stale; a late flush from an old renderer generation is
      // rejected by the reconciler's generation guard, so racing a successor
      // publisher is safe.
      deps.publish({
        generation: readGeneration(),
        epoch: epoch++,
        views: [],
      })
    },
  }
}
