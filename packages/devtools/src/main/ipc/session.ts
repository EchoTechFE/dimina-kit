import type { CompileConfig } from '../../shared/types.js'
import { ProjectChannel } from '../../shared/ipc-channels.js'
import {
  ProjectCaptureThumbnailSchema,
  ProjectGetCompileConfigSchema,
  ProjectGetPagesSchema,
  ProjectGetThumbnailSchema,
  ProjectOpenSchema,
  ProjectSaveCompileConfigSchema,
} from '../../shared/ipc-schemas.js'
// eslint-disable-next-line no-restricted-syntax -- grandfathered(workbench-context): shrink-only
import type { WorkbenchContext } from '../services/workbench-context.js'
import type { WorkbenchModule } from '../services/module.js'
import type { Disposable } from '@dimina-kit/electron-deck/main'
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
    .handle(ProjectChannel.Rebuild, async () => {
      const session = ctx.workspace.getSession()
      if (!session) throw new Error('project:rebuild — no active project session')
      // A host CompilationAdapter predating session.rebuild must not break:
      // degrade discernibly so the renderer falls back to reattach-only.
      if (typeof session.rebuild !== 'function') return { supported: false }
      await session.rebuild()
      return { supported: true }
    })
    .handle(ProjectChannel.CaptureThumbnail, (_, ...args: unknown[]) => {
      const [projectPath] = validate(
        ProjectChannel.CaptureThumbnail,
        ProjectCaptureThumbnailSchema,
        args,
      )
      return ctx.workspace.captureThumbnail(projectPath)
    })
    .handle(ProjectChannel.GetThumbnail, (_, ...args: unknown[]) => {
      const [projectPath] = validate(
        ProjectChannel.GetThumbnail,
        ProjectGetThumbnailSchema,
        args,
      )
      return ctx.workspace.getThumbnail(projectPath)
    })
}

export const sessionModule: WorkbenchModule = {
  setup: (ctx) => registerSessionIpc(ctx),
}
