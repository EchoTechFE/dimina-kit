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

/**
 * Renderer-driven overlay bounds.
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
 */
export function registerViewsIpc(
  ctx: Pick<WorkbenchContext, 'views' | 'senderPolicy'>,
): Disposable {
  const registry = new IpcRegistry(ctx.senderPolicy)
    // Window-level placement snapshot: the single source of truth for every
    // managed native view's bounds/visibility/z-order. The renderer's central
    // publisher coalesces one snapshot per frame; the reconciler diffs it
    // against the actual view tree. Supersedes the per-view bounds channels.
    .handle(ViewChannel.PlacementSnapshot, (_event, ...args: unknown[]) => {
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
    .handle(ViewChannel.HostToolbarGetHeight, () => ctx.views.getHostToolbarHeight())
    // Same mount-time replay role as HostToolbarGetHeight, on the sidebar's
    // inline (width) axis.
    .handle(ViewChannel.HostSidebarGetWidth, () => ctx.views.getHostSidebarWidth())

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
    if (event.sender.id !== ctx.views.getHostToolbarWebContentsId()) return
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
    if (event.sender.id !== ctx.views.getHostSidebarWebContentsId()) return
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
    if (event.sender.id !== ctx.views.getHostDialogWebContentsId()) return
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
