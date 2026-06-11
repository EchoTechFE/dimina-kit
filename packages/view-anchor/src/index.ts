/**
 * view-anchor — engine-agnostic primitive that keeps a main-process native
 * view (Electron `WebContentsView`) aligned to a DOM element's geometry.
 *
 * Public surface:
 *   - `createViewAnchor`    — forward: DOM rect → native view bounds.
 *   - `useViewAnchor`       — React adapter returning a ref callback.
 *   - `createSizeAdvertiser`— reverse: downstream content size → host.
 *   - `Bounds` / `AdvertisedSize` / option + handle types.
 *
 * Self-contained on purpose: the only runtime deps are `react` (adapter
 * only) and browser APIs (`ResizeObserver` / `requestAnimationFrame` /
 * `getBoundingClientRect`). See the design notes and the interactive 3D
 * walkthrough in `docs/` (`mechanism.mdx` / `anchor-3d.html`).
 */
export {
  createViewAnchor,
  measurePlacement,
  createPlacementAnchor,
} from './view-anchor.js'
export type {
  PlacementAnchorOptions,
  PlacementAnchorHandle,
} from './view-anchor.js'
export type {
  Bounds,
  Placement,
  ViewAnchorOptions,
  ViewAnchorHandle,
} from './types.js'
export { useViewAnchor } from './react.js'
export type { UseViewAnchorOptions, ViewAnchorRef } from './react.js'
export { createSizeAdvertiser } from './size-advertiser.js'
export type {
  AdvertisedAxis,
  AdvertisedSize,
  SizeAdvertiserOptions,
  SizeAdvertiserHandle,
} from './types.js'
