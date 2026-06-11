import type { WorkbenchModule } from '../services/module.js'
import { DisposableRegistry } from '@dimina-kit/electron-deck/main'
import { registerSimulatorIpc } from './simulator.js'
import { installBridgeRouter } from './bridge-router.js'
import { registerViewsIpc } from './views.js'

/**
 * The 'simulator' built-in module fans out into the simulator + views IPC
 * registrars. Bundle them under a single module so app.ts only sees one
 * entry per BuiltinModuleId.
 *
 * Bridge router (native-host PAGE_OPEN / NAV_ACTION / TAB_ACTION etc.) hooks
 * up unconditionally — the `__diminaNativeHost.enabled` flag in the simulator
 * window decides whether to actually call dmb:* channels, but the main-side
 * handlers must always be ready or `ipcRenderer.invoke('dmb:spawn')` fails
 * with `No handler registered`.
 */
export const simulatorModule: WorkbenchModule = {
  setup: (ctx) => {
    const reg = new DisposableRegistry()
    reg.add(registerSimulatorIpc(ctx))
    reg.add(registerViewsIpc(ctx))
    installBridgeRouter(ctx)
    return reg
  },
}
