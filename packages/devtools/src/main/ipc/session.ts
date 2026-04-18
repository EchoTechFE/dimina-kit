import { ipcMain } from 'electron'
import type { CompileConfig } from '../../shared/types.js'
import { ProjectChannel } from '../../shared/ipc-channels.js'
import type { WorkbenchContext } from '../services/workbench-context.js'

export function registerSessionIpc(ctx: Pick<WorkbenchContext, 'workspace'>): void {
  ipcMain.handle(ProjectChannel.Open, (_, projectPath: string) =>
    ctx.workspace.openProject(projectPath),
  )

  ipcMain.handle(ProjectChannel.GetPages, (_, projectPath: string) =>
    ctx.workspace.getProjectPages(projectPath),
  )

  ipcMain.handle(ProjectChannel.GetCompileConfig, (_, projectPath: string) =>
    ctx.workspace.getCompileConfig(projectPath),
  )

  ipcMain.handle(ProjectChannel.SaveCompileConfig, (_, projectPath: string, config: CompileConfig) =>
    ctx.workspace.saveCompileConfig(projectPath, config),
  )

  ipcMain.handle(ProjectChannel.Close, () => ctx.workspace.closeProject())
}
