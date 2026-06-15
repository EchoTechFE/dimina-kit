import { AppChannel } from '../../shared/ipc-channels.js'
// eslint-disable-next-line no-restricted-syntax -- grandfathered(workbench-context): shrink-only
import type { WorkbenchContext } from '../services/workbench-context.js'
import type { Disposable } from '@dimina-kit/electron-deck/main'
import { IpcRegistry } from '../utils/ipc-registry.js'

export function registerAppIpc(ctx: Pick<WorkbenchContext, 'brandingProvider' | 'appName' | 'senderPolicy'>): Disposable {
  return new IpcRegistry(ctx.senderPolicy)
    .handle(AppChannel.GetBranding, async () => {
      if (ctx.brandingProvider) return ctx.brandingProvider()
      return { appName: ctx.appName }
    })
}
