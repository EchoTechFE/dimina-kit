// The devtools view set fed through the placement reconciler. The reconcile
// core (@dimina-kit/electron-deck/layout) is domain-neutral over opaque string
// ids and an Extra type param; these are devtools' concrete bindings. Lives in
// shared/ so both the main-process reconciler and the renderer's placement
// publisher import the same ids and layers.

export const VIEW_ID = {
  simulator: 'simulator',
  simulatorDevtools: 'simulator-devtools',
  workbench: 'workbench',
  hostToolbar: 'host-toolbar',
  settings: 'settings',
  popover: 'popover',
  tooltip: 'tooltip',
} as const

export type DevtoolsViewId = (typeof VIEW_ID)[keyof typeof VIEW_ID]

// The only host-specific field: the simulator carries a zoom percent that maps
// to the native WCV's zoomFactor (and propagates to nested render guests).
export interface DevtoolsExtra {
  zoom?: number
}

// z-order layers; larger paints on top. Base overlays share layer 0 (they never
// overlap each other — the simulator device WCV, the console/DevTools WCV, and
// the embedded workbench occupy disjoint dock regions). The host-toolbar strip
// sits above the base row; settings and popover are the top tier (settings below
// a simultaneously-open popover), replacing the imperative raiseTopOverlays.
// tooltip sits above ALL of them — it must never be occluded by a popover/
// settings sheet either, and it's the reason this layer exists at all: a
// DOM-portaled (Radix) tooltip rendered by the main window's OWN renderer, or
// even the browser-native `title` attribute, is part of that renderer's paint
// surface and renders BEHIND every other WCV mounted on top of it (simulator,
// editor, settings, popover) — CSS z-index cannot reach across that boundary.
// Routing the tooltip through this same reconciler (a real WCV of its own,
// placed via `setOverlayDesired`) is what actually fixes that; see
// `overlay-panels-view.ts`'s tooltip functions.
export const VIEW_LAYER = {
  base: 0,
  hostToolbar: 5,
  settings: 10,
  popover: 20,
  tooltip: 30,
} as const
