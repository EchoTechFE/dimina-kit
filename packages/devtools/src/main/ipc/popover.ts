// eslint-disable-next-line no-restricted-syntax -- grandfathered(workbench-context): shrink-only
import type { WorkbenchContext } from '../services/workbench-context.js'
import type { WorkbenchModule } from '../services/module.js'
import { PopoverChannel } from '../../shared/ipc-channels-overlays.js'
import {
  PopoverShowSchema,
  PopoverApplySchema,
} from '../../shared/ipc-schemas.js'
import type { Disposable } from '@dimina-kit/electron-deck/main'
import { validate } from '../utils/ipc-schema.js'
import { IpcRegistry } from '../utils/ipc-registry.js'
import { toIpcContextSource, type IpcInput } from '../utils/ipc-context-source.js'

type PopoverIpcCtx = Pick<WorkbenchContext, 'views' | 'notify' | 'senderPolicy' | 'workspace'>

export function registerPopoverIpc(input: IpcInput<PopoverIpcCtx>): Disposable {
  return new IpcRegistry(toIpcContextSource(input))
    .handleRouted(PopoverChannel.Show, (ctx, _event, ...args: unknown[]) => {
      const [data] = validate(PopoverChannel.Show, PopoverShowSchema, args)
      // A stale/misbehaving renderer may still send the old `modes` field —
      // never trust it. The live state always comes from the currently open
      // project's store, injected here.
      const { modes: _modes, ...rest } = data as Record<string, unknown>
      const { state } = ctx.workspace.getCompileModeState()
      ctx.views.showPopover({ ...rest, state })
    })
    .handleRouted(PopoverChannel.Hide, (ctx) => {
      ctx.views.hidePopover()
    })
    .handleRouted(PopoverChannel.Apply, async (ctx, _event, ...args: unknown[]) => {
      const [payload] = validate(PopoverChannel.Apply, PopoverApplySchema, args)
      // Hide BEFORE touching the store: a slow or failing apply must never
      // leave a stale popover window on screen.
      ctx.views.hidePopover()
      try {
        return await ctx.workspace.applyCompileModeCommand(payload.command)
      } catch (err) {
        ctx.notify.compileModesApplyFailed({
          message: err instanceof Error ? err.message : String(err),
        })
        throw err
      }
    })
}

export const popoverModule: WorkbenchModule = {
  setup: (ctx) => registerPopoverIpc(ctx),
}
