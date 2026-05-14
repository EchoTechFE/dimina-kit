import type { WorkbenchModule } from '../services/module.js'
import { DisposableRegistry } from '../utils/disposable.js'
import { registerSimulatorIpc } from './simulator.js'
import { registerPanelsIpc } from './panels.js'
import { registerToolbarIpc } from './toolbar.js'

/**
 * The 'simulator' built-in module fans out into three IPC registrars
 * (core simulator, panels, toolbar). Bundle them under a single module
 * so app.ts only sees one entry per BuiltinModuleId.
 */
export const simulatorModule: WorkbenchModule = {
  setup: (ctx) => {
    const reg = new DisposableRegistry()
    reg.add(registerSimulatorIpc(ctx))
    reg.add(registerPanelsIpc(ctx))
    reg.add(registerToolbarIpc(ctx))
    return reg
  },
}
