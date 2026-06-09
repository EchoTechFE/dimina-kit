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

/**
 * Explicit visibility + geometry for a native view, replacing the legacy
 * magic-`{0,0,0,0}` "hidden" convention (`present:false → ZERO bounds`).
 *
 * Visibility is a DISCRIMINANT, never inferred from geometry. The whole
 * reason this type exists: a genuinely zero-SIZED but on-screen view
 * (`{ visible:true, bounds:{...,width:0,height:0} }`) is now distinct from a
 * detached/hidden one (`{ visible:false }`, which carries no `bounds` at
 * all). Under the old ZERO convention both collapsed to the same value and
 * were indistinguishable.
 */
export type Placement =
  | { visible: true; bounds: Bounds }
  | { visible: false }

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
  /** Stop observing and remove listeners. After dispose the anchor never
   *  publishes again (every emit reads `disposed` synchronously, so there is
   *  no queued frame that could fire late). */
  dispose(): void
}

// ── Reverse direction: size advertiser ───────────────────────────────
//
// The mirror of the forward anchor. Runs in a DOWNSTREAM WebContentsView's own
// renderer: it measures the content's own size and advertises it to the host,
// which sizes the placeholder accordingly (and the forward anchor then keeps the
// view positioned). One advertiser owns exactly ONE axis — the other axis is a
// host-driven, read-only input — so the cross-process loop stays a one-way DAG.

/** Which axis this advertiser owns. `block` = height, `inline` = width
 *  (logical-property naming, axis-agnostic to writing mode). */
export type AdvertisedAxis = 'block' | 'inline'

/**
 * One frame of advertised size. A pure scalar plus the owning axis — there is
 * deliberately no field for the *other* axis, so "advertise two axes" is not
 * expressible (single-axis ownership is enforced in the type, not at runtime).
 */
export interface AdvertisedSize {
  /** Mirrors the factory's `axis`; constant across frames. Lets the host
   *  whitelist-check the axis it is willing to accept. */
  readonly axis: AdvertisedAxis
  /** The owned axis's content extent, in CSS px — already rounded and clamped
   *  to `>= 0`. */
  readonly extent: number
}

export interface SizeAdvertiserOptions {
  /** The single axis this advertiser owns. Fixed for the advertiser's life. */
  axis: AdvertisedAxis
  /** Receives each advertised size. Owns the IPC/postMessage → host. Mirrors
   *  the forward `publish` (same role: the injected, transport-owning sink). */
  publish: (size: AdvertisedSize) => void
}

export interface SizeAdvertiserHandle {
  /**
   * Swap the `publish` sink (e.g. a new IPC channel) and immediately
   * re-advertise the current size to it (mirrors the forward anchor's
   * re-publish on update), so the new channel is not left sizeless until the
   * next `ResizeObserver` tick.
   *
   * Takes only the new sink — `axis` is immutable by construction, so it is
   * deliberately not expressible here (you cannot attempt to change it). To
   * advertise a different axis, dispose and create a new advertiser.
   */
  update(publish: (size: AdvertisedSize) => void): void
  /**
   * Stop observing, cancel any pending RAF. After dispose nothing is
   * advertised again. (There is no ZERO/terminal value — collapsing is the
   * host's policy, unlike the forward anchor's `present:false`.)
   *
   * The first advertised value is asynchronous: it awaits the observer's first
   * frame, and a `display:none` target advertises nothing until shown.
   */
  dispose(): void
}
