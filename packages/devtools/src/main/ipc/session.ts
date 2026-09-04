import type { CompileConfig, CompileModes } from '../../shared/types.js'
import { ProjectChannel } from '../../shared/ipc-channels.js'
import {
  ProjectCaptureThumbnailSchema,
  ProjectGetCompileConfigSchema,
  ProjectGetCompileModesSchema,
  ProjectGetPagesSchema,
  ProjectGetThumbnailSchema,
  ProjectOpenSchema,
  ProjectSaveCompileConfigSchema,
  ProjectSaveCompileModesSchema,
} from '../../shared/ipc-schemas.js'
// eslint-disable-next-line no-restricted-syntax -- grandfathered(workbench-context): shrink-only
import type { WorkbenchContext } from '../services/workbench-context.js'
import type { WorkbenchModule } from '../services/module.js'
import type { Disposable } from '@dimina-kit/electron-deck/main'
import { validate } from '../utils/ipc-schema.js'
import { IpcRegistry } from '../utils/ipc-registry.js'
import { toIpcContextSource, type IpcInput } from '../utils/ipc-context-source.js'

type SessionIpcCtx = Pick<WorkbenchContext, 'workspace' | 'senderPolicy'>

export function registerSessionIpc(input: IpcInput<SessionIpcCtx>): Disposable {
  return new IpcRegistry(toIpcContextSource(input))
    .handleRouted(ProjectChannel.Open, (ctx, _e, ...args: unknown[]) => {
      const [projectPath] = validate(ProjectChannel.Open, ProjectOpenSchema, args)
      return ctx.workspace.openProject(projectPath)
    })
    .handleRouted(ProjectChannel.GetPages, (ctx, _e, ...args: unknown[]) => {
      const [projectPath] = validate(ProjectChannel.GetPages, ProjectGetPagesSchema, args)
      return ctx.workspace.getProjectPages(projectPath)
    })
    .handleRouted(ProjectChannel.GetCompileConfig, (ctx, _e, ...args: unknown[]) => {
      const [projectPath] = validate(
        ProjectChannel.GetCompileConfig,
        ProjectGetCompileConfigSchema,
        args,
      )
      return ctx.workspace.getCompileConfig(projectPath)
    })
    .handleRouted(ProjectChannel.SaveCompileConfig, (ctx, _e, ...args: unknown[]) => {
      const [projectPath, config] = validate(
        ProjectChannel.SaveCompileConfig,
        ProjectSaveCompileConfigSchema,
        args,
      )
      return ctx.workspace.saveCompileConfig(projectPath, config as CompileConfig)
    })
    .handleRouted(ProjectChannel.GetCompileModes, (ctx, _e, ...args: unknown[]) => {
      const [projectPath] = validate(
        ProjectChannel.GetCompileModes,
        ProjectGetCompileModesSchema,
        args,
      )
      return ctx.workspace.getCompileModes(projectPath)
    })
    .handleRouted(ProjectChannel.SaveCompileModes, (ctx, _e, ...args: unknown[]) => {
      const [projectPath, modes] = validate(
        ProjectChannel.SaveCompileModes,
        ProjectSaveCompileModesSchema,
        args,
      )
      return ctx.workspace.saveCompileModes(projectPath, modes as CompileModes)
    })
    .handleRouted(ProjectChannel.Close, (ctx) => {
      return ctx.workspace.closeProject()
    })
    .handleRouted(ProjectChannel.Rebuild, async (ctx) => {
      const session = ctx.workspace.getSession()
      if (!session) throw new Error('project:rebuild — no active project session')
      // A host CompilationAdapter predating session.rebuild must not break:
      // degrade discernibly so the renderer falls back to reattach-only.
      if (typeof session.rebuild !== 'function') return { supported: false }
      await session.rebuild()
      return { supported: true }
    })
    .handleRouted(ProjectChannel.CaptureThumbnail, (ctx, _e, ...args: unknown[]) => {
      const [projectPath] = validate(
        ProjectChannel.CaptureThumbnail,
        ProjectCaptureThumbnailSchema,
        args,
      )
      return ctx.workspace.captureThumbnail(projectPath)
    })
    .handleRouted(ProjectChannel.GetThumbnail, (ctx, _e, ...args: unknown[]) => {
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
