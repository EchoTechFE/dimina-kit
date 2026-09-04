// eslint-disable-next-line no-restricted-syntax -- grandfathered(workbench-context): shrink-only
import type { WorkbenchContext } from '../services/workbench-context.js'
import type { WorkbenchModule } from '../services/module.js'
import type { CompileModes } from '../../shared/types.js'
import { PopoverChannel } from '../../shared/ipc-channels-overlays.js'
import {
  PopoverShowSchema,
  PopoverApplySchema,
} from '../../shared/ipc-schemas.js'
import type { Disposable } from '@dimina-kit/electron-deck/main'
import { validate } from '../utils/ipc-schema.js'
import { IpcRegistry } from '../utils/ipc-registry.js'
import { toIpcContextSource, type IpcInput } from '../utils/ipc-context-source.js'

type PopoverIpcCtx = Pick<WorkbenchContext, 'views' | 'notify' | 'senderPolicy'>

export function registerPopoverIpc(input: IpcInput<PopoverIpcCtx>): Disposable {
  return new IpcRegistry(toIpcContextSource(input))
    .handleRouted(PopoverChannel.Show, (ctx, _event, ...args: unknown[]) => {
      const [data] = validate(PopoverChannel.Show, PopoverShowSchema, args)
      ctx.views.showPopover(data)
    })
    .handleRouted(PopoverChannel.Hide, (ctx) => {
      ctx.views.hidePopover()
    })
    .onRouted(PopoverChannel.Apply, (ctx, _event, ...args: unknown[]) => {
      const [payload] = validate(PopoverChannel.Apply, PopoverApplySchema, args)
      ctx.views.hidePopover()
      ctx.notify.popoverApply({
        modes: payload.modes as CompileModes,
        relaunch: payload.relaunch,
      })
    })
}

export const popoverModule: WorkbenchModule = {
  setup: (ctx) => registerPopoverIpc(ctx),
}
