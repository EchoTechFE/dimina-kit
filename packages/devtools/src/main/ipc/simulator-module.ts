import type { WorkbenchModule } from '../services/module.js'
import { toDisposable } from '@dimina-kit/electron-deck/main'
import { registerSimulatorIpc } from './simulator.js'
import { installBridgeRouter } from './bridge-router.js'

/**
 * The 'simulator' built-in module. views.ts's `registerViewsIpc` is NOT
 * bundled in here — it's registered unconditionally by app.ts (see that call
 * site's comment for why: host-sidebar/host-toolbar placement has no real
 * dependency on the simulator module).
 *
 * Bridge router (native-host PAGE_OPEN / NAV_ACTION / TAB_ACTION etc.) hooks
 * up unconditionally — the `__diminaNativeHost.enabled` flag in the simulator
 * window decides whether to actually call dmb:* channels, but the main-side
 * handlers must always be ready or `ipcRenderer.invoke('dmb:spawn')` fails
 * with `No handler registered`.
 *
 * The router installs onto a concrete context (it assigns `ctx.bridge`,
 * `ctx.consoleForwarder` and `ctx.diagnostics`, which the window assembly
 * reads straight afterwards), so it is per-window wiring rather than
 * app-level registration.
 */
export const simulatorModule: WorkbenchModule = {
  setup: (source) => registerSimulatorIpc(source),
  setupWindow: (ctx) => {
    installBridgeRouter(ctx)
    return toDisposable(() => {})
  },
}
