import { InternalDevtoolsChannel } from '../../shared/ipc-channels.js'
import type { Disposable } from '@dimina-kit/electron-deck/main'
import { IpcRegistry, type SenderPolicy } from '../utils/ipc-registry.js'
import { toIpcContextSource, type IpcInput } from '../utils/ipc-context-source.js'
import type { InternalDevtoolsWindow } from '../windows/internal-devtools-window/index.js'

/**
 * Standalone internal (app-wide) DevTools debug window. The simulator
 * toolbar's "debug" button opens (or focuses) it via the window controller —
 * a module-local narrow deps interface, not `WorkbenchContext`, per the
 * shrink-only WorkbenchContext-import gate (see eslint.config.js).
 */
export interface InternalDevtoolsIpcDeps {
  internalDevtoolsWindow?: InternalDevtoolsWindow
  senderPolicy: SenderPolicy
}

export function registerInternalDevtoolsIpc(input: IpcInput<InternalDevtoolsIpcDeps>): Disposable {
  return new IpcRegistry(toIpcContextSource(input))
    .handleRouted(InternalDevtoolsChannel.Open, (ctx) => {
      ctx.internalDevtoolsWindow?.open()
    })
}
