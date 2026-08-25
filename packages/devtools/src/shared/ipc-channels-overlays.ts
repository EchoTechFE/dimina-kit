/**
 * IPC channel name constants for dimina-devtools' overlay/panel
 * WebContentsViews — layout slots (host-toolbar/host-sidebar/host-dialog),
 * the popover, tooltip, project-create dialog and settings overlays, plus
 * the update flow. Split out of `ipc-channels.ts` (see that file's header)
 * once this group alone pushed it past the repo's file-length threshold —
 * these constants share no runtime dependency on the rest of that file, so
 * the split is a pure line-count relief valve, not a behavior change.
 */

// ── Embedded views (renderer → main) ─────────────────────────────────────
//
// The main window's React layout owns the *positions* of the editor +
// simulator-DevTools WebContentsView overlays — each visible placeholder
// `<div>` measures its client rect via ResizeObserver and pushes the
// rectangle to the main process. The view manager caches the latest
// payload per kind and applies it to the overlay; no payload means the
// overlay is hidden.
//
// Payload (after schema validation): `{ x, y, width, height }` in CSS
// pixels relative to the window's content area (origin = top-left,
// not including the OS chrome).
export const ViewChannel = {
  /**
   * Reverse size-advertiser: the host-toolbar WCV's OWN renderer advertises its
   * intrinsic content height so main reserves exactly that much. Payload
   * `{ axis: 'block', extent }`. fire-and-forget (send), NOT invoke.
   */
  HostToolbarAdvertiseHeight: 'view:host-toolbar:advertise-height',
  /**
   * main → host-toolbar WCV renderer: per-load MessagePort handshake for the
   * gated narrow channel. On every toolbar `did-finish-load` main creates a
   * `MessageChannelMain` and transfers port2 here
   * (`wc.postMessage(HostToolbarPort, null, [port2])`); the session-resident
   * toolbar runtime preload receives it via `event.ports[0]` and bridges it to
   * the page as `window.diminaHostToolbar`. Envelope both directions:
   * `{ channel: string, payload: unknown }`.
   */
  HostToolbarPort: 'view:host-toolbar:port',
  /**
   * main → main-window renderer: push the reserved host-toolbar height so the
   * renderer placeholder div resizes (closing the dynamic-height loop).
   */
  HostToolbarHeightChanged: 'view:host-toolbar:height-changed',
  /**
   * main ← main-window renderer (invoke): pull the last NOTIFIED toolbar
   * height retained in main. Mount-time replay companion to
   * `HostToolbarHeightChanged`: the push listener mounts with the project
   * view and the toolbar's size-advertiser deduplicates (never re-reports),
   * so a height pushed while no project view was mounted would otherwise be
   * lost forever (cold start on the project list races it; close-project →
   * reopen hits it deterministically). No payload; resolves a number.
   */
  HostToolbarGetHeight: 'view:host-toolbar:get-height',
  /**
   * Reverse size-advertiser for the host-sidebar WCV, mirroring
   * `HostToolbarAdvertiseHeight` on the inline (width) axis instead of block.
   * Payload `{ axis: 'inline', extent }`. fire-and-forget (send), NOT invoke.
   */
  HostSidebarAdvertiseWidth: 'view:host-sidebar:advertise-width',
  /**
   * main → host-sidebar WCV renderer: per-load MessagePort handshake, same
   * contract as `HostToolbarPort` (see that entry).
   */
  HostSidebarPort: 'view:host-sidebar:port',
  /**
   * main → main-window renderer: push the reserved host-sidebar width so the
   * renderer placeholder div resizes, mirroring `HostToolbarHeightChanged`.
   */
  HostSidebarWidthChanged: 'view:host-sidebar:width-changed',
  /**
   * main ← main-window renderer (invoke): pull the last NOTIFIED sidebar
   * width, mirroring `HostToolbarGetHeight`'s mount-time replay role.
   */
  HostSidebarGetWidth: 'view:host-sidebar:get-width',
  /**
   * Reverse size-advertiser for the host-dialog WCV. Unlike the toolbar/sidebar
   * (single-axis, `setBaseDesired`-placed strips), the dialog is a BOTH-AXES
   * overlay positioned by `setOverlayDesired` — main centers it in the main
   * window once it knows both dimensions. One channel carries either axis'
   * report (`{ axis: 'block' | 'inline', extent }`); the dialog's own content
   * advertises both from the same root (see `host-dialog-advertiser.ts`).
   * fire-and-forget (send), NOT invoke.
   *
   * No `HostDialogSizeChanged` / `HostDialogGetSize` counterparts: those exist
   * for toolbar/sidebar so a renderer-owned PLACEHOLDER can replay a size it
   * missed. The dialog has no such placeholder — it is a main-driven overlay
   * shown/hidden on demand (`hostDialog.show()`/`hide()`), so there is nothing
   * in the renderer to replay a size into.
   */
  HostDialogAdvertiseSize: 'view:host-dialog:advertise-size',
  /**
   * main → host-dialog WCV renderer: per-load MessagePort handshake, same
   * contract as `HostToolbarPort` (see that entry).
   */
  HostDialogPort: 'view:host-dialog:port',
  /**
   * Renderer → main: the window-level placement snapshot (one monotonic epoch
   * per commit tick, one generation per renderer lifetime) that drives the view
   * reconciler. The single source of truth for every managed native view's
   * bounds/visibility/z-order — supersedes the per-view bounds channels above.
   * invoke.
   */
  PlacementSnapshot: 'view:placement-snapshot',
  /**
   * main ← main-window renderer (invoke): allocate a fresh placement
   * generation seed for this renderer bootstrap. See
   * renderer-placement-generation.ts for why the seed comes from main
   * (a wall-clock `Date.now()` seed is not guaranteed to exceed main's
   * still-standing high-water mark across two reloads that happen faster
   * than the clock's resolution). No payload; resolves a number.
   */
  AllocatePlacementGeneration: 'view:allocate-placement-generation',
} as const

export interface ViewBounds {
  x: number
  y: number
  width: number
  height: number
}

// ── Popover ──────────────────────────────────────────────────────────────

export const PopoverChannel = {
  Show: 'popover:show',
  Hide: 'popover:hide',
  Relaunch: 'popover:relaunch',
  Closed: 'popover:closed',
  Init: 'popover:init',
} as const

// ── Tooltip ──────────────────────────────────────────────────────────────
//
// A top-tier overlay WebContentsView (VIEW_LAYER.tooltip — see view-ids.ts),
// NOT a DOM tooltip in the main renderer: any DOM-portaled floating UI (Radix
// Tooltip) or the browser-native `title` attribute lives in the main
// renderer's own paint surface, which every other WCV (simulator, editor,
// settings, popover) renders on top of — CSS cannot reach across that
// boundary. A trigger reports its anchor rect + label; main computes the
// tooltip's screen bounds and shows/repositions/hides this overlay.

export const OverlayChannel = {
  Ready: 'overlay:ready',
} as const

export const TooltipChannel = {
  Prepare: 'tooltip:prepare',
  Show: 'tooltip:show',
  Hide: 'tooltip:hide',
  Init: 'tooltip:init',
  Measured: 'tooltip:measured',
} as const

// ── Project-create dialog ───────────────────────────────────────────────
//
// A top-tier overlay WebContentsView (VIEW_LAYER.dialog), NOT the Radix
// `fixed inset-0` DOM portal it replaced — a DOM overlay paints inside the
// main window's own renderer, so any native WebContentsView mounted on top
// (simulator, host-toolbar, host-sidebar) occludes it. main.tsx fetches the
// template catalog + base-dir defaults, then asks main to show this panel;
// the panel relays submit/cancel back to main.tsx to run the existing
// scaffold flow.

export const ProjectCreateChannel = {
  Show: 'projectCreate:show',
  Init: 'projectCreate:init',
  Submit: 'projectCreate:submit',
  Cancel: 'projectCreate:cancel',
  Submitted: 'projectCreate:submitted',
} as const

// ── Embedded settings overlay ────────────────────────────────────────────

export const SettingsChannel = {
  SetVisible: 'settings:setVisible',
  ConfigChanged: 'settings:configChanged',
  ProjectSettingsChanged: 'settings:projectSettingsChanged',
  Init: 'settings:init',
} as const

// ── Updates (UpdateManager) ──────────────────────────────────────────────
//
// String values are FROZEN: shipped builds key off them. Add new entries
// here, never rename existing ones.
export const UpdateChannel = {
  Check: 'updates:check',
  Download: 'updates:download',
  Install: 'updates:install',
  DownloadProgress: 'updates:downloadProgress',
  Available: 'updates:available',
  Close: 'updates:close',
} as const
