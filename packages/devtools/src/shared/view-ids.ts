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
export const VIEW_LAYER = {
  base: 0,
  hostToolbar: 5,
  settings: 10,
  popover: 20,
} as const
