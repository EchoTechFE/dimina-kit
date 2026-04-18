import { ipcMain, webContents } from 'electron'
import { PanelChannel } from '../../shared/ipc-channels.js'
import type { WorkbenchContext } from '../services/workbench-context.js'

const BUILTIN_PANELS = [
  { id: 'wxml', label: 'WXML' },
  { id: 'appdata', label: 'AppData' },
  { id: 'storage', label: 'Storage' },
]

export function registerPanelsIpc(ctx: Pick<WorkbenchContext, 'panels' | 'views' | 'workspace'>): void {
  ipcMain.handle(PanelChannel.List, () => {
    return BUILTIN_PANELS
      .filter((p) => ctx.panels.includes(p.id))
  })

  ipcMain.handle(PanelChannel.Eval, async (_, expression: string) => {
    const simWcId = ctx.views.getSimulatorWebContentsId()
    if (!ctx.workspace.hasActiveSession() || simWcId == null) return undefined
    const sim = webContents.fromId(simWcId)
    if (!sim || sim.isDestroyed()) return undefined
    try {
      return await sim.executeJavaScript(expression)
    } catch {
      return undefined
    }
  })

  ipcMain.handle(PanelChannel.Select, (_event, _panelId: string) => {
    // Hide the simulator overlay when switching to a built-in panel
    if (ctx.views.hasSimulatorView() && ctx.views.isSimulatorAdded()) {
      ctx.views.hideSimulator()
    }
  })

  ipcMain.handle(PanelChannel.SelectSimulator, () => {
    if (ctx.views.hasSimulatorView() && !ctx.views.isSimulatorAdded()) {
      ctx.views.showSimulator(ctx.views.getLastSimWidth())
    }
  })
}
