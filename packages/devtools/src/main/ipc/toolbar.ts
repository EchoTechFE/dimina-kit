import { ToolbarChannel } from '../../shared/ipc-channels.js'
import type { WorkbenchContext } from '../services/workbench-context.js'
import type { Disposable } from '../utils/disposable.js'
import { IpcRegistry } from '../utils/ipc-registry.js'

export function registerToolbarIpc(ctx: Pick<WorkbenchContext, 'toolbarActions' | 'senderPolicy'>): Disposable {
  return new IpcRegistry(ctx.senderPolicy)
    .handle(ToolbarChannel.GetActions, async () => {
      if (ctx.toolbarActions) return ctx.toolbarActions()
      return []
    })
}
