import type { WorkbenchModule } from '../services/module.js'
import type { ViewManager } from '../services/views/view-manager.js'
import { OverlayChannel, TooltipChannel } from '../../shared/ipc-channels.js'
import { TooltipMeasuredSchema, TooltipShowSchema } from '../../shared/ipc-schemas.js'
import type { Disposable } from '@dimina-kit/electron-deck/main'
import { validate } from '../utils/ipc-schema.js'
import { IpcRegistry, type SenderPolicy } from '../utils/ipc-registry.js'

/** Module-local narrow deps — deliberately NOT `Pick<WorkbenchContext, ...>`
 * (the gate in eslint.config.* is shrink-only; see its message). */
export interface TooltipIpcDeps {
  views: Pick<
    ViewManager,
    | 'prepareTooltip'
    | 'showTooltip'
    | 'hideTooltip'
    | 'markOverlayReady'
    | 'applyTooltipMeasurement'
  >
  senderPolicy?: SenderPolicy
}

export function registerTooltipIpc(ctx: TooltipIpcDeps): Disposable {
  return new IpcRegistry(ctx.senderPolicy)
    .on(TooltipChannel.Prepare, () => {
      ctx.views.prepareTooltip()
    })
    .on(TooltipChannel.Show, (_event, ...args: unknown[]) => {
      const [data] = validate(TooltipChannel.Show, TooltipShowSchema, args)
      ctx.views.showTooltip(data)
    })
    .on(TooltipChannel.Hide, () => {
      ctx.views.hideTooltip()
    })
    .on(OverlayChannel.Ready, (event) => {
      ctx.views.markOverlayReady(event.sender.id)
    })
    .on(TooltipChannel.Measured, (event, ...args: unknown[]) => {
      const [measurement] = validate(
        TooltipChannel.Measured,
        TooltipMeasuredSchema,
        args,
      )
      ctx.views.applyTooltipMeasurement(event.sender.id, measurement)
    })
}

export const tooltipModule: WorkbenchModule = {
  setup: (ctx) => registerTooltipIpc(ctx),
}
