import { SimulatorChannel, SimulatorCustomApiChannel, WorkbenchChannel } from '../../shared/ipc-channels.js'
import {
  SimulatorAttachSchema,
  SimulatorCustomApiInvokeSchema,
  SimulatorResizeSchema,
  SimulatorSetVisibleSchema,
} from '../../shared/ipc-schemas.js'
import { simulatorApiRegistry } from '../services/simulator/custom-apis.js'
import type { WorkbenchContext } from '../services/workbench-context.js'
import type { Disposable } from '../utils/disposable.js'
import { validate } from '../utils/ipc-schema.js'
import { IpcRegistry } from '../utils/ipc-registry.js'

export function registerSimulatorIpc(ctx: Pick<WorkbenchContext, 'views' | 'panels' | 'apiNamespaces' | 'notify' | 'senderPolicy'>): Disposable {
  return new IpcRegistry(ctx.senderPolicy)
    .handle(SimulatorChannel.Attach, (_, ...args: unknown[]) => {
      const [simWcId, simWidth] = validate(SimulatorChannel.Attach, SimulatorAttachSchema, args)
      ctx.views.attachSimulator(simWcId, simWidth)
    })
    .handle(SimulatorChannel.Detach, () => {
      ctx.views.detachSimulator()
    })
    .handle(SimulatorChannel.Resize, (_, ...args: unknown[]) => {
      const [simWidth] = validate(SimulatorChannel.Resize, SimulatorResizeSchema, args)
      ctx.views.resize(simWidth)
    })
    .handle(SimulatorChannel.SetVisible, (_, ...args: unknown[]) => {
      const [visible, simWidth] = validate(SimulatorChannel.SetVisible, SimulatorSetVisibleSchema, args)
      ctx.views.setVisible(visible, simWidth)
    })
    .handle(SimulatorCustomApiChannel.List, () => {
      return simulatorApiRegistry.list()
    })
    .handle(SimulatorCustomApiChannel.Invoke, (_, ...args: unknown[]) => {
      const [name, params] = validate(SimulatorCustomApiChannel.Invoke, SimulatorCustomApiInvokeSchema, args)
      return simulatorApiRegistry.invoke(name, params)
    })
    .handle(WorkbenchChannel.GetPanelConfig, () => {
      return ctx.panels
    })
    .handle(WorkbenchChannel.GetApiNamespaces, () => {
      return ctx.apiNamespaces
    })
    .on(WorkbenchChannel.Reset, () => {
      ctx.notify.workbenchReset()
    })
}
