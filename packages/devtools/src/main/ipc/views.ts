import type { IpcMainEvent } from 'electron'
import { ipcMain } from 'electron'
import { ViewChannel } from '../../shared/ipc-channels.js'
import {
  ViewBoundsSchema,
  HostToolbarAdvertiseHeightSchema,
} from '../../shared/ipc-schemas.js'
import type { WorkbenchContext } from '../services/workbench-context.js'
import type { Disposable } from '../utils/disposable.js'
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
    .handle(ViewChannel.SimulatorDevtoolsBounds, (_event, ...args: unknown[]) => {
      const [bounds] = validate(
        ViewChannel.SimulatorDevtoolsBounds,
        ViewBoundsSchema,
        args,
      )
      ctx.views.setSimulatorDevtoolsBounds(bounds)
    })
    // Host-controllable toolbar: forward anchor (the MAIN renderer measures the
    // placeholder rect → toolbar WCV bounds). invoke, mirroring
    // SimulatorDevtoolsBounds. Sender is the trusted main renderer.
    .handle(ViewChannel.HostToolbarBounds, (_event, ...args: unknown[]) => {
      const [bounds] = validate(
        ViewChannel.HostToolbarBounds,
        ViewBoundsSchema,
        args,
      )
      ctx.views.setHostToolbarBounds(bounds)
    })

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

  return {
    dispose() {
      void registry.dispose()
      ipcMain.removeListener(ViewChannel.HostToolbarAdvertiseHeight, onAdvertiseHeight)
    },
  }
}
