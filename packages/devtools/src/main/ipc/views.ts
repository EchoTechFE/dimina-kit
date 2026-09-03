import type { IpcMainEvent } from 'electron'
import { ipcMain } from 'electron'
import { ViewChannel } from '../../shared/ipc-channels-overlays.js'
import {
  PlacementSnapshotSchema,
  HostToolbarAdvertiseHeightSchema,
  HostSidebarAdvertiseWidthSchema,
  HostDialogAdvertiseSizeSchema,
} from '../../shared/ipc-schemas.js'
// eslint-disable-next-line no-restricted-syntax -- grandfathered(workbench-context): shrink-only
import type { WorkbenchContext } from '../services/workbench-context.js'
import type { Disposable } from '@dimina-kit/electron-deck/main'
import { validate } from '../utils/ipc-schema.js'
import { IpcRegistry } from '../utils/ipc-registry.js'
import { toIpcContextSource, type IpcInput } from '../utils/ipc-context-source.js'

type ViewsIpcCtx = Pick<WorkbenchContext, 'views' | 'senderPolicy'>

/**
 * Renderer-driven overlay bounds, plus the renderer bootstrap's
 * placement-generation seed pull.
 *
 * The main window's React layout is the source of truth for where the
 * editor view and the simulator's Chromium DevTools overlay live on
 * screen. A `ResizeObserver` in the renderer watches each placeholder
 * `<div>` and publishes its client rect (in CSS pixels, relative to the
 * window's content area) through these channels. The view manager caches
 * the latest payload per kind and applies it to the WebContentsView.
 *
 * Width / height = 0 is the canonical "overlay hidden" signal — the React
 * panel is collapsed or the tab is not selected. The view manager removes
 * the child view from the contentView but keeps the WebContents alive so
 * subsequent re-shows skip the OpenSumi DI bootstrap.
 *
 * Registered UNCONDITIONALLY by app.ts — NOT gated behind `modules.simulator`
 * (`WorkbenchAppConfig.modules`). None of `ctx.views` (`ViewManager`) is
 * itself conditional on that toggle — it's constructed unconditionally in
 * `createContext` and used unconditionally elsewhere (onResize, the
 * update-dialog panel, workbench detach) — and host-sidebar in particular
 * lives on the project-list page, wholly unrelated to the mini-program
 * simulator webview a disabled `modules.simulator` would actually skip. Every
 * renderer entry point also blocks its first render on
 * `AllocatePlacementGeneration` (see renderer-placement-generation.ts) —
 * gating any of this behind the simulator toggle would strand a host that
 * disables it on the fatal boot-failure page, or leave placement silently
 * non-functional. See disabled-module.test.ts for the end-to-end guard.
 */
export function registerViewsIpc(input: IpcInput<ViewsIpcCtx>): Disposable {
  const source = toIpcContextSource(input)

  // The raw listeners below trust an exact wc id, and each window mounts its
  // own host slots — so the id itself names the owning window. Scanning the
  // live contexts for the one whose slot holds this sender is both the trust
  // gate and the routing decision; no match means the message came from
  // somewhere that is not a host slot at all, and is dropped.
  const ownerOfSlot = (
    event: IpcMainEvent,
    slotWebContentsId: (ctx: ViewsIpcCtx) => number | null,
  ): ViewsIpcCtx | null =>
    source.list().find((ctx) => slotWebContentsId(ctx) === event.sender.id) ?? null

  const registry = new IpcRegistry(source)
    // Renderer bootstrap: allocate this session's placement-generation seed
    // (see renderer-placement-generation.ts / PlacementReconciler.allocateGeneration).
    .handleRouted(ViewChannel.AllocatePlacementGeneration, (ctx) => ctx.views.allocatePlacementGeneration())
    // Window-level placement snapshot: the single source of truth for every
    // managed native view's bounds/visibility/z-order. The renderer's central
    // publisher coalesces one snapshot per frame; the reconciler diffs it
    // against the actual view tree. Supersedes the per-view bounds channels.
    .handleRouted(ViewChannel.PlacementSnapshot, (ctx, _event, ...args: unknown[]) => {
      const [snapshot] = validate(
        ViewChannel.PlacementSnapshot,
        PlacementSnapshotSchema,
        args,
      )
      ctx.views.setPlacementSnapshot(snapshot)
    })
    // Height replay pull: a freshly-mounted main-renderer placeholder asks for
    // the last NOTIFIED toolbar height (main retains it — the toolbar's
    // size-advertiser deduplicates and never re-pushes, so a push that fired
    // while no project view was mounted is otherwise lost: cold start races
    // it, close-project → reopen hits it always). Rides the SAME
    // senderPolicy-gated registry as HostToolbarBounds: the toolbar WCV's
    // arbitrary host content must not reach this — only the trusted main
    // renderer pulls. Live delegation, not a registration-time snapshot.
    .handleRouted(ViewChannel.HostToolbarGetHeight, (ctx) => ctx.views.getHostToolbarHeight())
    // Same mount-time replay role as HostToolbarGetHeight, on the sidebar's
    // inline (width) axis.
    .handleRouted(ViewChannel.HostSidebarGetWidth, (ctx) => ctx.views.getHostSidebarWidth())

  // Reverse size-advertiser: the toolbar WCV's OWN renderer sends this, and the
  // host loads ARBITRARY content into that WCV. We DELIBERATELY do NOT add the
  // toolbar wc to the global sender policy — that would trust it for ALL ~72
  // IpcRegistry channels (project-fs / session / settings / panels
  // executeJavaScript / storage …), a large blast radius if the host content is
  // ever compromised. Instead this is a RAW `ipcMain.on` gated on the EXACT
  // current host-toolbar wc id — the same precise-sender-id trust model the
  // simulator custom-api bridge uses (view-manager `attachNativeCustomApiBridge`).
  // The host content can reach ONLY this one channel, carrying only a
  // non-negative integer height.
  const onAdvertiseHeight = (event: IpcMainEvent, ...args: unknown[]): void => {
    const ctx = ownerOfSlot(event, (c) => c.views.getHostToolbarWebContentsId())
    if (!ctx) return
    let extent: number
    try {
      ;[{ extent }] = validate(
        ViewChannel.HostToolbarAdvertiseHeight,
        HostToolbarAdvertiseHeightSchema,
        args,
      )
    } catch {
      return // malformed payload from the host's own content — drop it
    }
    ctx.views.setHostToolbarHeight(extent)
  }
  ipcMain.on(ViewChannel.HostToolbarAdvertiseHeight, onAdvertiseHeight)

  // Same precise-sender-id trust model as onAdvertiseHeight, on the
  // sidebar's inline (width) axis.
  const onAdvertiseWidth = (event: IpcMainEvent, ...args: unknown[]): void => {
    const ctx = ownerOfSlot(event, (c) => c.views.getHostSidebarWebContentsId())
    if (!ctx) return
    let extent: number
    try {
      ;[{ extent }] = validate(
        ViewChannel.HostSidebarAdvertiseWidth,
        HostSidebarAdvertiseWidthSchema,
        args,
      )
    } catch {
      return // malformed payload from the host's own content — drop it
    }
    ctx.views.setHostSidebarWidth(extent)
  }
  ipcMain.on(ViewChannel.HostSidebarAdvertiseWidth, onAdvertiseWidth)

  // Same precise-sender-id trust model as onAdvertiseHeight/onAdvertiseWidth,
  // but the dialog is a single by-demand overlay rather than a persistent
  // slot: either axis may arrive, and the view manager re-centers using
  // whichever axes it has measured so far.
  const onAdvertiseDialogSize = (event: IpcMainEvent, ...args: unknown[]): void => {
    const ctx = ownerOfSlot(event, (c) => c.views.getHostDialogWebContentsId())
    if (!ctx) return
    let axis: 'block' | 'inline'
    let extent: number
    try {
      ;[{ axis, extent }] = validate(
        ViewChannel.HostDialogAdvertiseSize,
        HostDialogAdvertiseSizeSchema,
        args,
      )
    } catch {
      return // malformed payload from the host's own content — drop it
    }
    ctx.views.reportHostDialogMeasuredExtent(axis, extent)
  }
  ipcMain.on(ViewChannel.HostDialogAdvertiseSize, onAdvertiseDialogSize)

  return {
    dispose() {
      void registry.dispose()
      ipcMain.removeListener(ViewChannel.HostToolbarAdvertiseHeight, onAdvertiseHeight)
      ipcMain.removeListener(ViewChannel.HostSidebarAdvertiseWidth, onAdvertiseWidth)
      ipcMain.removeListener(ViewChannel.HostDialogAdvertiseSize, onAdvertiseDialogSize)
    },
  }
}
