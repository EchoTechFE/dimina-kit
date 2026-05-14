import type { CompileConfig } from '../../shared/types.js'
import { ProjectChannel } from '../../shared/ipc-channels.js'
import {
  ProjectGetCompileConfigSchema,
  ProjectGetPagesSchema,
  ProjectOpenSchema,
  ProjectSaveCompileConfigSchema,
} from '../../shared/ipc-schemas.js'
import type { WorkbenchContext } from '../services/workbench-context.js'
import type { WorkbenchModule } from '../services/module.js'
import type { Disposable } from '../utils/disposable.js'
import { validate } from '../utils/ipc-schema.js'
import { IpcRegistry } from '../utils/ipc-registry.js'

export function registerSessionIpc(ctx: Pick<WorkbenchContext, 'workspace' | 'senderPolicy'>): Disposable {
  return new IpcRegistry(ctx.senderPolicy)
    .handle(ProjectChannel.Open, (_, ...args: unknown[]) => {
      const [projectPath] = validate(ProjectChannel.Open, ProjectOpenSchema, args)
      return ctx.workspace.openProject(projectPath)
    })
    .handle(ProjectChannel.GetPages, (_, ...args: unknown[]) => {
      const [projectPath] = validate(ProjectChannel.GetPages, ProjectGetPagesSchema, args)
      return ctx.workspace.getProjectPages(projectPath)
    })
    .handle(ProjectChannel.GetCompileConfig, (_, ...args: unknown[]) => {
      const [projectPath] = validate(
        ProjectChannel.GetCompileConfig,
        ProjectGetCompileConfigSchema,
        args,
      )
      return ctx.workspace.getCompileConfig(projectPath)
    })
    .handle(ProjectChannel.SaveCompileConfig, (_, ...args: unknown[]) => {
      const [projectPath, config] = validate(
        ProjectChannel.SaveCompileConfig,
        ProjectSaveCompileConfigSchema,
        args,
      )
      return ctx.workspace.saveCompileConfig(projectPath, config as CompileConfig)
    })
    .handle(ProjectChannel.Close, () => {
      return ctx.workspace.closeProject()
    })
}

export const sessionModule: WorkbenchModule = {
  setup: (ctx) => registerSessionIpc(ctx),
}
