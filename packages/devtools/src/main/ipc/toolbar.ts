import { ipcMain } from 'electron'
import { ToolbarChannel } from '../../shared/ipc-channels.js'
import type { WorkbenchContext } from '../services/workbench-context.js'

export function registerToolbarIpc(ctx: Pick<WorkbenchContext, 'toolbarActions'>): void {
  ipcMain.handle(ToolbarChannel.GetActions, async () => {
    if (ctx.toolbarActions) return ctx.toolbarActions()
    return []
  })
}
