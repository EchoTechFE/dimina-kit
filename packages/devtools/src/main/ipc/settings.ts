import { app } from 'electron'
import type { WorkbenchContext } from '../services/workbench-context.js'
import { openSettingsWindow } from '../app/launch.js'
import type { ProjectSettings } from '../services/projects/project-repository.js'
import {
  loadWorkbenchSettings,
  saveWorkbenchSettings,
  applyTheme,
  type WorkbenchSettings,
  type ThemeSource,
} from '../services/settings/index.js'
import { WorkbenchSettingsChannel, SettingsChannel } from '../../shared/ipc-channels.js'
import { DEFAULT_CDP_PORT } from '../../shared/constants.js'
import {
  SettingsConfigChangedSchema,
  SettingsProjectSettingsChangedSchema,
  SettingsSetVisibleSchema,
  WorkbenchSettingsSaveSchema,
  WorkbenchSettingsSetThemeSchema,
  WorkbenchSettingsSetVisibleSchema,
} from '../../shared/ipc-schemas.js'
import type { CompileConfig } from '../../shared/types.js'
import type { Disposable } from '../utils/disposable.js'
import type { WorkbenchModule } from '../services/module.js'
import { validate } from '../utils/ipc-schema.js'
import { IpcRegistry } from '../utils/ipc-registry.js'

export function registerSettingsIpc(ctx: Pick<WorkbenchContext, 'views' | 'notify' | 'workspace' | 'rendererDir' | 'senderPolicy' | 'windows'>): Disposable {
  return new IpcRegistry(ctx.senderPolicy)
    .handle(WorkbenchSettingsChannel.Get, () => {
      return loadWorkbenchSettings()
    })
    .handle(WorkbenchSettingsChannel.Save, (_, ...args: unknown[]) => {
      const [settings] = validate(
        WorkbenchSettingsChannel.Save,
        WorkbenchSettingsSaveSchema,
        args,
      )
      saveWorkbenchSettings(settings as WorkbenchSettings)
      applyTheme((settings.theme as ThemeSource | undefined) ?? 'system')
      return { success: true }
    })
    .handle(WorkbenchSettingsChannel.SetTheme, (_, ...args: unknown[]) => {
      const [theme] = validate(
        WorkbenchSettingsChannel.SetTheme,
        WorkbenchSettingsSetThemeSchema,
        args,
      )
      applyTheme(theme)
    })
    .handle(WorkbenchSettingsChannel.GetCdpStatus, () => {
      const settings = loadWorkbenchSettings()
      const switchValue = app.commandLine.getSwitchValue('remote-debugging-port')
      const implicitDevDefault = !app.isPackaged && !settings.cdp.enabled && switchValue === String(DEFAULT_CDP_PORT)
      return {
        configured: settings.cdp.enabled,
        port: settings.cdp.port,
        active: !!switchValue,
        activePort: switchValue ? parseInt(switchValue, 10) : null,
        implicitDevDefault,
      }
    })
    .handle(WorkbenchSettingsChannel.SetVisible, async (_, ...args: unknown[]) => {
      const [visible] = validate(
        WorkbenchSettingsChannel.SetVisible,
        WorkbenchSettingsSetVisibleSchema,
        args,
      )
      if (visible) {
        await openSettingsWindow(ctx)
      } else {
        ctx.windows.closeSettingsWindow()
      }
    })
    .handle(SettingsChannel.SetVisible, async (_, ...args: unknown[]) => {
      const [visible] = validate(SettingsChannel.SetVisible, SettingsSetVisibleSchema, args)
      if (visible) {
        await ctx.views.showSettings()
        const projectPath = ctx.workspace.getProjectPath()
        ctx.notify.settingsInit({
          projectPath,
          config: await ctx.workspace.getCompileConfig(projectPath),
          projectSettings: ctx.workspace.getProjectSettings(projectPath),
        })
      } else {
        ctx.views.hideSettings()
        ctx.notify.settingsClosed()
      }
    })
    .on(SettingsChannel.ConfigChanged, async (_, ...args: unknown[]) => {
      const [config] = validate(
        SettingsChannel.ConfigChanged,
        SettingsConfigChangedSchema,
        args,
      )
      const projectPath = ctx.workspace.getProjectPath()
      if (projectPath) {
        await ctx.workspace.saveCompileConfig(projectPath, config as CompileConfig)
      }
      ctx.notify.settingsChanged(config as CompileConfig)
    })
    .on(SettingsChannel.ProjectSettingsChanged, (_, ...args: unknown[]) => {
      const [patch] = validate(
        SettingsChannel.ProjectSettingsChanged,
        SettingsProjectSettingsChangedSchema,
        args,
      )
      ctx.workspace.updateProjectSettings(
        ctx.workspace.getProjectPath(),
        patch as Partial<ProjectSettings>,
      )
    })
}

export const settingsModule: WorkbenchModule = {
  setup: (ctx) => registerSettingsIpc(ctx),
}
