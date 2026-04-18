import { ipcMain } from 'electron'
import { SimulatorChannel, WorkbenchChannel } from '../../shared/ipc-channels.js'
import type { WorkbenchContext } from '../services/workbench-context.js'

export function registerSimulatorIpc(ctx: Pick<WorkbenchContext, 'views' | 'panels' | 'apiNamespaces' | 'notify'>): void {
  ipcMain.handle(SimulatorChannel.Attach, (_, simWcId: number, simWidth: number) => {
    ctx.views.attachSimulator(simWcId, simWidth)
  })

  ipcMain.handle(SimulatorChannel.Detach, () => {
    ctx.views.detachSimulator()
  })

  ipcMain.handle(SimulatorChannel.Resize, (_, simWidth: number) => {
    ctx.views.resize(simWidth)
  })

  ipcMain.handle(SimulatorChannel.SetVisible, (_, visible: boolean, simWidth: number) => {
    ctx.views.setVisible(visible, simWidth)
  })

  ipcMain.handle(WorkbenchChannel.GetPanelConfig, () => {
    return ctx.panels
  })

  ipcMain.handle(WorkbenchChannel.GetApiNamespaces, () => {
    return ctx.apiNamespaces
  })

  ipcMain.on(WorkbenchChannel.Reset, () => {
    ctx.notify.workbenchReset()
  })
}
