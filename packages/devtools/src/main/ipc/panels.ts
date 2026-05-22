import { PanelChannel } from '../../shared/ipc-channels.js'
import {
  PanelEvalSchema,
  PanelSelectSchema,
} from '../../shared/ipc-schemas.js'
import type { WorkbenchContext } from '../services/workbench-context.js'
import type { Disposable } from '../utils/disposable.js'
import { validate } from '../utils/ipc-schema.js'
import { IpcRegistry } from '../utils/ipc-registry.js'

const BUILTIN_PANELS = [
  { id: 'wxml', label: 'WXML' },
  { id: 'appdata', label: 'AppData' },
  { id: 'storage', label: 'Storage' },
]

export function registerPanelsIpc(ctx: Pick<WorkbenchContext, 'panels' | 'views' | 'workspace' | 'senderPolicy'>): Disposable {
  return new IpcRegistry(ctx.senderPolicy)
    .handle(PanelChannel.List, () => {
      return BUILTIN_PANELS
        .filter((p) => ctx.panels.includes(p.id))
    })
    .handle(PanelChannel.Eval, async (_event, ...args: unknown[]) => {
      const [expression] = validate(PanelChannel.Eval, PanelEvalSchema, args)
      if (!ctx.workspace.hasActiveSession()) return undefined
      const sim = ctx.views.getSimulatorWebContents()
      if (!sim) return undefined
      try {
        return await sim.executeJavaScript(expression)
      }
      catch {
        return undefined
      }
    })
    .handle(PanelChannel.Select, (_event, ...args: unknown[]) => {
      validate(PanelChannel.Select, PanelSelectSchema, args)
      if (ctx.views.hasSimulatorView() && ctx.views.isSimulatorAdded()) {
        ctx.views.hideSimulator()
      }
    })
    .handle(PanelChannel.SelectSimulator, () => {
      if (ctx.views.hasSimulatorView() && !ctx.views.isSimulatorAdded()) {
        ctx.views.showSimulator(ctx.views.getLastSimWidth())
      }
    })
}
