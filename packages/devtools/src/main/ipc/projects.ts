import { dialog } from 'electron'
import { ProjectsChannel, DialogChannel } from '../../shared/ipc-channels.js'
import {
  ProjectsAddSchema,
  ProjectsRemoveSchema,
} from '../../shared/ipc-schemas.js'
import type { WorkbenchContext } from '../services/workbench-context.js'
import type { WorkbenchModule } from '../services/module.js'
import type { Disposable } from '../utils/disposable.js'
import { validate } from '../utils/ipc-schema.js'
import { IpcRegistry } from '../utils/ipc-registry.js'

export function registerProjectsIpc(ctx: Pick<WorkbenchContext, 'workspace' | 'mainWindow' | 'senderPolicy'>): Disposable {
  return new IpcRegistry(ctx.senderPolicy)
    .handle(ProjectsChannel.List, () => {
      return ctx.workspace.listProjects()
    })
    .handle(DialogChannel.OpenDirectory, async () => {
      const result = await dialog.showOpenDialog(ctx.mainWindow, {
        properties: ['openDirectory'],
        title: '选择小程序项目目录',
      })
      return result.canceled ? null : result.filePaths[0]
    })
    .handle(ProjectsChannel.Add, (_event, ...args: unknown[]) => {
      const [dirPath] = validate(ProjectsChannel.Add, ProjectsAddSchema, args)
      return ctx.workspace.addProject(dirPath)
    })
    .handle(ProjectsChannel.Remove, (_event, ...args: unknown[]) => {
      const [dirPath] = validate(ProjectsChannel.Remove, ProjectsRemoveSchema, args)
      return ctx.workspace.removeProject(dirPath)
    })
}

export const projectsModule: WorkbenchModule = {
  setup: (ctx) => registerProjectsIpc(ctx),
}
