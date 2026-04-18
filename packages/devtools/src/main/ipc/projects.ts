import { ipcMain, dialog } from 'electron'
import { ProjectsChannel, DialogChannel } from '../../shared/ipc-channels.js'
import type { WorkbenchContext } from '../services/workbench-context.js'

export function registerProjectsIpc(ctx: Pick<WorkbenchContext, 'workspace' | 'mainWindow'>): void {
  ipcMain.handle(ProjectsChannel.List, () => ctx.workspace.listProjects())

  ipcMain.handle(DialogChannel.OpenDirectory, async () => {
    const result = await dialog.showOpenDialog(ctx.mainWindow, {
      properties: ['openDirectory'],
      title: '选择小程序项目目录',
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle(ProjectsChannel.Add, (_, dirPath: string) =>
    ctx.workspace.addProject(dirPath),
  )

  ipcMain.handle(ProjectsChannel.Remove, (_, dirPath: string) =>
    ctx.workspace.removeProject(dirPath),
  )
}
