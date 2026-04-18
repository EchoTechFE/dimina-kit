import { ipcMain } from 'electron'
import fs from 'fs'
import { AppChannel } from '../../shared/ipc-channels.js'
import type { WorkbenchContext } from '../services/workbench-context.js'

export function registerAppIpc(ctx: Pick<WorkbenchContext, 'preloadPath' | 'brandingProvider' | 'appName'>): void {
  ipcMain.handle(AppChannel.GetPreloadPath, () => {
    return `file://${fs.realpathSync(ctx.preloadPath)}`
  })

  ipcMain.handle(AppChannel.GetBranding, async () => {
    if (ctx.brandingProvider) return ctx.brandingProvider()
    return { appName: ctx.appName }
  })
}
