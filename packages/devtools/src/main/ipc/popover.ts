import type { WorkbenchContext } from '../services/workbench-context.js'
import type { WorkbenchModule } from '../services/module.js'
import type { CompileConfig } from '../../shared/types.js'
import { PopoverChannel } from '../../shared/ipc-channels.js'
import {
  PopoverShowSchema,
  PopoverRelaunchSchema,
} from '../../shared/ipc-schemas.js'
import type { Disposable } from '../utils/disposable.js'
import { validate } from '../utils/ipc-schema.js'
import { IpcRegistry } from '../utils/ipc-registry.js'

export function registerPopoverIpc(ctx: Pick<WorkbenchContext, 'views' | 'notify' | 'senderPolicy'>): Disposable {
  return new IpcRegistry(ctx.senderPolicy)
    .handle(PopoverChannel.Show, (_event, ...args: unknown[]) => {
      const [data] = validate(PopoverChannel.Show, PopoverShowSchema, args)
      ctx.views.showPopover(data)
    })
    .handle(PopoverChannel.Hide, () => {
      ctx.views.hidePopover()
    })
    .on(PopoverChannel.Relaunch, (_event, ...args: unknown[]) => {
      const [newConfig] = validate(PopoverChannel.Relaunch, PopoverRelaunchSchema, args)
      ctx.views.hidePopover()
      ctx.notify.popoverRelaunch(newConfig as CompileConfig)
    })
}

export const popoverModule: WorkbenchModule = {
  setup: (ctx) => registerPopoverIpc(ctx),
}
