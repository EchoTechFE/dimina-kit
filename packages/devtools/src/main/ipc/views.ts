import { ViewChannel } from '../../shared/ipc-channels.js'
import { ViewBoundsSchema } from '../../shared/ipc-schemas.js'
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
  return new IpcRegistry(ctx.senderPolicy)
    .handle(ViewChannel.SimulatorDevtoolsBounds, (_event, ...args: unknown[]) => {
      const [bounds] = validate(
        ViewChannel.SimulatorDevtoolsBounds,
        ViewBoundsSchema,
        args,
      )
      ctx.views.setSimulatorDevtoolsBounds(bounds)
    })
}
