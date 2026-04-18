import { ipcMain } from 'electron'
import type { WorkbenchContext } from '../services/workbench-context.js'
import type { CompileConfig } from '../../shared/types.js'
import { PopoverChannel } from '../../shared/ipc-channels.js'

export function registerPopoverIpc(ctx: Pick<WorkbenchContext, 'views' | 'notify'>): void {
  ipcMain.handle(PopoverChannel.Show, (_event: unknown, data: unknown) => {
    ctx.views.showPopover(data)
  })

  ipcMain.handle(PopoverChannel.Hide, () => ctx.views.hidePopover())

  ipcMain.on(PopoverChannel.Relaunch, (_, newConfig: CompileConfig) => {
    ctx.views.hidePopover()
    ctx.notify.popoverRelaunch(newConfig)
  })
}
