import { app, dialog } from 'electron'
import path from 'path'
import { ProjectsChannel, DialogChannel } from '../../shared/ipc-channels.js'
import {
  ProjectsAddSchema,
  ProjectsRemoveSchema,
} from '../../shared/ipc-schemas.js'
// eslint-disable-next-line no-restricted-syntax -- grandfathered(workbench-context): shrink-only
import type { WorkbenchContext } from '../services/workbench-context.js'
import type { WorkbenchModule } from '../services/module.js'
import type { Disposable } from '@dimina-kit/electron-deck/main'
import { validate } from '../utils/ipc-schema.js'
import { IpcRegistry } from '../utils/ipc-registry.js'
import { sanitizeTemplates } from '../services/projects/templates.js'
import { createProject } from '../services/projects/create-project-service.js'
import type { CreateProjectInput } from '../services/projects/types.js'
import {
  loadWorkbenchSettings,
  saveWorkbenchSettings,
} from '../services/settings/index.js'

type ProjectsIpcCtx = Pick<
  WorkbenchContext,
  | 'workspace'
  | 'windows'
  | 'senderPolicy'
  | 'projectsProvider'
  | 'projectTemplates'
  | 'customCreateProjectDialog'
>

export function registerProjectsIpc(ctx: ProjectsIpcCtx): Disposable {
  return new IpcRegistry(ctx.senderPolicy)
    .handle(ProjectsChannel.List, () => {
      return ctx.workspace.listProjects()
    })
    .handle(DialogChannel.OpenDirectory, async () => {
      const result = await dialog.showOpenDialog(ctx.windows.mainWindow, {
        properties: ['openDirectory'],
        title: '选择小程序项目目录',
      })
      return result.canceled ? null : result.filePaths[0]
    })
    .handle(ProjectsChannel.Add, async (_event, ...args: unknown[]) => {
      const [dirPath] = validate(ProjectsChannel.Add, ProjectsAddSchema, args)
      const dirError = await ctx.workspace.validateProjectDir(dirPath)
      if (dirError) {
        await dialog.showMessageBox(ctx.windows.mainWindow, {
          type: 'error',
          title: '无法导入项目',
          message: '该目录不是有效的小程序项目',
          detail: dirError,
          buttons: ['确定'],
        })
        throw new Error(dirError)
      }
      const duplicate = await ctx.workspace.hasProject(dirPath)
      const project = await ctx.workspace.addProject(dirPath)
      if (duplicate) {
        await dialog.showMessageBox(ctx.windows.mainWindow, {
          type: 'info',
          title: '项目已存在',
          message: '该项目已在列表中',
          detail: dirPath,
          buttons: ['确定'],
        })
      }
      return project
    })
    .handle(ProjectsChannel.Remove, (_event, ...args: unknown[]) => {
      const [dirPath] = validate(ProjectsChannel.Remove, ProjectsRemoveSchema, args)
      return ctx.workspace.removeProject(dirPath)
    })
    // ── template catalog + create flow ──
    .handle(ProjectsChannel.ListTemplates, () => {
      // Sanitize at the IPC boundary: `generate` is a function and the
      // structured-clone algorithm Electron uses for invoke would otherwise
      // throw "could not be cloned" before the renderer ever sees it.
      return sanitizeTemplates(ctx.projectTemplates ?? [])
    })
    .handle(ProjectsChannel.OpenCreateDialog, async () => {
      if (!ctx.customCreateProjectDialog) return null
      const sanitized = sanitizeTemplates(ctx.projectTemplates ?? [])
      return await ctx.customCreateProjectDialog({
        parentWindow: ctx.windows.mainWindow,
        templates: sanitized,
      })
    })
    .handle(ProjectsChannel.Create, async (_event, ...args: unknown[]) => {
      // We deliberately don't run this through zod yet — the input shape is
      // wide (any template can stash arbitrary `extra` fields) and the
      // service does its own per-field validation. Bound size to keep this
      // a cheap DoS guard.
      const [raw] = args
      if (!raw || typeof raw !== 'object') {
        throw new Error('projects:create expects a CreateProjectInput object')
      }
      const input = raw as CreateProjectInput
      let project
      try {
        project = await createProject(input, {
          templates: ctx.projectTemplates ?? [],
          projectsProvider: ctx.projectsProvider,
        })
      } catch (err) {
        // Mirror the Add flow: surface scaffold failures (invalid name,
        // non-empty target dir, missing template, remote backend reject,
        // …) as a native dialog so users see *why* the create silently
        // fizzled. The renderer's catch then just bails out.
        await dialog.showMessageBox(ctx.windows.mainWindow, {
          type: 'error',
          title: '创建项目失败',
          message: '无法创建项目',
          detail: err instanceof Error ? err.message : String(err),
          buttons: ['确定'],
        })
        throw err
      }
      // Remember the parent of the just-created project so the next open of
      // the create dialog pre-fills its directory under the same workspace.
      try {
        const settings = loadWorkbenchSettings()
        const newBase = path.dirname(input.path)
        if (newBase && settings.lastCreateBaseDir !== newBase) {
          saveWorkbenchSettings({ ...settings, lastCreateBaseDir: newBase })
        }
      } catch (err) {
        console.warn('[projects:create] failed to persist lastCreateBaseDir', err)
      }
      return project
    })
    .handle(ProjectsChannel.GetCreateDefaults, () => {
      // Fallback chain: persisted last parent → user's Documents → home.
      // Documents covers the common "我把项目都放在 Documents/ 下" case for
      // first-time users on macOS; home is just a safe final fallback.
      const settings = loadWorkbenchSettings()
      const baseDir =
        settings.lastCreateBaseDir ??
        safeAppPath('documents') ??
        safeAppPath('home') ??
        ''
      return { baseDir }
    })
}

function safeAppPath(name: 'documents' | 'home'): string | null {
  try {
    return app.getPath(name)
  } catch {
    return null
  }
}

export const projectsModule: WorkbenchModule = {
  setup: (ctx) => registerProjectsIpc(ctx),
}
