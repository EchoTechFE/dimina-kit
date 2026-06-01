/**
 * view-anchor — engine-agnostic primitive that keeps a main-process native
 * view (Electron `WebContentsView`) aligned to a DOM element's geometry.
 *
 * Public surface:
 *   - `createViewAnchor` — imperative core (no React, no Electron).
 *   - `useViewAnchor`    — React adapter returning a ref callback.
 *   - `Bounds` / option + handle types.
 *
 * Self-contained on purpose: the only runtime deps are `react` (adapter
 * only) and browser APIs (`ResizeObserver` / `requestAnimationFrame` /
 * `getBoundingClientRect`). Lift this directory out to a package and it
 * compiles unchanged — see the design notes in `docs/`.
 */
export { createViewAnchor } from './view-anchor'
export type { Bounds, ViewAnchorOptions, ViewAnchorHandle } from './types'
export { useViewAnchor } from './react'
export type { UseViewAnchorOptions, ViewAnchorRef } from './react'
