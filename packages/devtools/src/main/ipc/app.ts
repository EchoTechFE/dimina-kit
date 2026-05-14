import fs from 'fs'
import { AppChannel } from '../../shared/ipc-channels.js'
import type { WorkbenchContext } from '../services/workbench-context.js'
import type { Disposable } from '../utils/disposable.js'
import { IpcRegistry } from '../utils/ipc-registry.js'

export function registerAppIpc(ctx: Pick<WorkbenchContext, 'preloadPath' | 'brandingProvider' | 'appName' | 'senderPolicy'>): Disposable {
  return new IpcRegistry(ctx.senderPolicy)
    .handle(AppChannel.GetPreloadPath, () => {
      return `file://${fs.realpathSync(ctx.preloadPath)}`
    })
    .handle(AppChannel.GetBranding, async () => {
      if (ctx.brandingProvider) return ctx.brandingProvider()
      return { appName: ctx.appName }
    })
}
