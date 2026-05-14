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

export function registerSettingsIpc(ctx: Pick<WorkbenchContext, 'workbenchSettingsWindow' | 'views' | 'notify' | 'workspace' | 'mainWindow' | 'rendererDir' | 'senderPolicy' | 'windows'>): Disposable {
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
      const implicitDevDefault = !app.isPackaged && !settings.cdp.enabled && switchValue === '9222'
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
        ctx.notify.settingsInit({
          projectPath: ctx.workspace.getProjectPath(),
          config: ctx.workspace.getCompileConfig(ctx.workspace.getProjectPath()),
          projectSettings: ctx.workspace.getProjectSettings(ctx.workspace.getProjectPath()),
        })
      } else {
        ctx.views.hideSettings()
        ctx.notify.settingsClosed()
      }
    })
    .on(SettingsChannel.ConfigChanged, (_, ...args: unknown[]) => {
      const [config] = validate(
        SettingsChannel.ConfigChanged,
        SettingsConfigChangedSchema,
        args,
      )
      if (ctx.workspace.getProjectPath()) {
        ctx.workspace.saveCompileConfig(
          ctx.workspace.getProjectPath(),
          config as CompileConfig,
        )
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
