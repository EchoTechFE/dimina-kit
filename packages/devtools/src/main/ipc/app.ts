import { AppChannel } from '../../shared/ipc-channels.js'
// eslint-disable-next-line no-restricted-syntax -- grandfathered(workbench-context): shrink-only
import type { WorkbenchContext } from '../services/workbench-context.js'
import type { Disposable } from '@dimina-kit/electron-deck/main'
import { IpcRegistry } from '../utils/ipc-registry.js'
import { toIpcContextSource, type IpcInput } from '../utils/ipc-context-source.js'

type AppIpcCtx = Pick<WorkbenchContext, 'brandingProvider' | 'appName' | 'senderPolicy'>

export function registerAppIpc(input: IpcInput<AppIpcCtx>): Disposable {
  return new IpcRegistry(toIpcContextSource(input))
    .handleRouted(AppChannel.GetBranding, async (ctx) => {
      if (ctx.brandingProvider) return ctx.brandingProvider()
      return { appName: ctx.appName }
    })
}
