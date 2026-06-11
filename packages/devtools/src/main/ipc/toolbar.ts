import { ToolbarChannel } from '../../shared/ipc-channels.js'
import { ToolbarInvokeSchema } from '../../shared/ipc-schemas.js'
import type { WorkbenchContext } from '../services/workbench-context.js'
import type { Disposable } from '@dimina-kit/electron-deck/main'
import { validate } from '../utils/ipc-schema.js'
import { IpcRegistry } from '../utils/ipc-registry.js'

export function registerToolbarIpc(ctx: Pick<WorkbenchContext, 'toolbar' | 'senderPolicy'>): Disposable {
  return new IpcRegistry(ctx.senderPolicy)
    .handle(ToolbarChannel.GetActions, () => {
      // Project to {id,label}[] — the non-serialisable handler never leaves
      // the main process.
      return ctx.toolbar.list()
    })
    .handle(ToolbarChannel.Invoke, async (_, ...args: unknown[]) => {
      const [id] = validate(ToolbarChannel.Invoke, ToolbarInvokeSchema, args)
      const handler = ctx.toolbar.getHandler(id)
      if (!handler) {
        throw new Error(`Toolbar action "${id}" is not registered`)
      }
      await handler()
    })
}
