/**
 * view-anchor — sync a main-process native view's bounds to a DOM element.
 *
 * Self-contained, engine-agnostic primitive. It knows nothing about
 * Electron (the `publish` callback owns the IPC → `setBounds`), nothing
 * about React (the core is imperative; see `react.ts` for the adapter),
 * and nothing about the host layout engine (the `target` element may come
 * from our own `compile`/`FrameTree`, or — later — a dockview panel's
 * `content.element`; the mechanism is identical).
 *
 * It is the modern, alive replacement for the archived
 * `react-electron-browser-view`: the cross-process bridge that DOM layout
 * libraries (dockview included) deliberately do not provide. dockview's
 * internal `OverlayRenderContainer` does the same getBoundingClientRect →
 * RAF → reposition dance, but its follower is a DOM node; ours is a native
 * `WebContentsView` positioned via the injected `publish`.
 */

/** A screen-space rectangle, in CSS pixels. Structurally compatible with
 *  the host's `ViewBounds` so a publisher typed against either works. */
export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

export interface ViewAnchorOptions {
  /**
   * Whether the native view should be attached. When `false`, the anchor
   * publishes zero bounds (`{0,0,0,0}`) — the host treats `width === 0 ||
   * height === 0` as "detach the child view but keep its WebContents
   * alive" (detach-but-keep-alive). No DOM measurement is needed in this
   * state.
   */
  present: boolean
  /** Receives the live rect, or `{0,0,0,0}` when detached. Owns IPC. */
  publish: (bounds: Bounds) => void
  /**
   * Optional: publish THIS rect instead of `target.getBoundingClientRect()`.
   * The anchor still OBSERVES `target` (ResizeObserver + scroll) — `measure`
   * only redirects WHAT is published, not WHAT triggers a re-publish. Use it
   * when the element whose rect the native view must match is NOT the element
   * whose geometry signals the moves: e.g. the simulator overlays the bezel's
   * fixed-size inner screen, but that screen is centered+scrolled by its
   * column, so the anchor observes the SCROLL CONTAINER (which resizes on
   * splitter drag / window resize and fires `scroll`) while `measure` reports
   * the inner screen's rect.
   *
   * Returning `null` means "not measurable yet" (e.g. the measured descendant
   * hasn't attached): the anchor SKIPS that publish — it does NOT emit ZERO
   * and does NOT publish a stale rect — and waits for the next trigger. ZERO
   * (on `present:false`) is never routed through `measure`. The returned rect
   * is rounded identically to the default path (x/y rounded; width/height
   * `Math.max(0, Math.round(...))` — x/y may be negative when the measured
   * element is scrolled off the top/left edge).
   */
  measure?: () => Bounds | null
  /**
   * Optional: when `true`, intersect the measured rect with the CURRENT
   * `target.getBoundingClientRect()` (left=max, top=max, right=min, bottom=min)
   * before clamping/rounding, so the published bounds can never extend past the
   * visible scroll viewport. The native overlay (a main-process WebContentsView)
   * is NOT clipped by DOM `overflow`; this clamps it to the target's visible box
   * so it cannot bleed over surrounding chrome (top toolbar / bottom bar). An
   * empty intersection collapses to `width`/`height` 0 (the canonical "hidden"
   * signal). Absent/`false` → the measured rect is published unclipped.
   */
  clipToTarget?: boolean
}

export interface ViewAnchorHandle {
  /**
   * Apply new options. Re-publishes immediately to reflect the new state
   * (present=true → measure + observe; present=false → zero bounds).
   */
  update(opts: ViewAnchorOptions): void
  /** Stop observing and remove listeners. After dispose the anchor never
   *  publishes again (every emit reads `disposed` synchronously, so there is
   *  no queued frame that could fire late). */
  dispose(): void
}
