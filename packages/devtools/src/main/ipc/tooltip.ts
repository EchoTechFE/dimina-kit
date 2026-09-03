import type { WorkbenchModule } from '../services/module.js'
import type { ViewManager } from '../services/views/view-manager.js'
import { OverlayChannel, TooltipChannel } from '../../shared/ipc-channels-overlays.js'
import { TooltipMeasuredSchema, TooltipShowSchema } from '../../shared/ipc-schemas.js'
import type { Disposable } from '@dimina-kit/electron-deck/main'
import { validate } from '../utils/ipc-schema.js'
import { IpcRegistry, type SenderPolicy } from '../utils/ipc-registry.js'
import { toIpcContextSource, type IpcInput } from '../utils/ipc-context-source.js'

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

export function registerTooltipIpc(input: IpcInput<TooltipIpcDeps>): Disposable {
  return new IpcRegistry(toIpcContextSource(input))
    .onRouted(TooltipChannel.Prepare, (ctx) => {
      ctx.views.prepareTooltip()
    })
    .onRouted(TooltipChannel.Show, (ctx, _event, ...args: unknown[]) => {
      const [data] = validate(TooltipChannel.Show, TooltipShowSchema, args)
      ctx.views.showTooltip(data)
    })
    .onRouted(TooltipChannel.Hide, (ctx) => {
      ctx.views.hideTooltip()
    })
    .onRouted(OverlayChannel.Ready, (ctx, event) => {
      ctx.views.markOverlayReady(event.sender.id)
    })
    .onRouted(TooltipChannel.Measured, (ctx, event, ...args: unknown[]) => {
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
