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
}

export interface ViewAnchorHandle {
  /**
   * Apply new options. Re-publishes immediately to reflect the new state
   * (present=true → measure + observe; present=false → zero bounds).
   */
  update(opts: ViewAnchorOptions): void
  /** Stop observing, cancel any pending RAF, remove listeners. After
   *  dispose the anchor never publishes again (stale-RAF safe). */
  dispose(): void
}
