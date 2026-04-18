import { app, ipcMain } from 'electron'
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

export function registerSettingsIpc(ctx: Pick<WorkbenchContext, 'workbenchSettingsWindow' | 'views' | 'notify' | 'workspace' | 'mainWindow' | 'rendererDir'>): void {
  ipcMain.handle(WorkbenchSettingsChannel.Get, () => {
    return loadWorkbenchSettings()
  })

  ipcMain.handle(WorkbenchSettingsChannel.Save, (_, settings: WorkbenchSettings) => {
    saveWorkbenchSettings(settings)
    applyTheme(settings.theme ?? 'system')
    return { success: true }
  })

  ipcMain.handle(WorkbenchSettingsChannel.SetTheme, (_, theme: ThemeSource) => {
    applyTheme(theme)
  })

  ipcMain.handle(WorkbenchSettingsChannel.GetCdpStatus, () => {
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

  ipcMain.handle(WorkbenchSettingsChannel.SetVisible, async (_, visible: boolean) => {
    if (visible) {
      await openSettingsWindow(ctx)
    } else {
      ctx.workbenchSettingsWindow?.close()
    }
  })

  ipcMain.handle(SettingsChannel.SetVisible, async (_, visible: boolean) => {
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

  ipcMain.on(SettingsChannel.ConfigChanged, (_, config: import('../../shared/types.js').CompileConfig) => {
    if (ctx.workspace.getProjectPath()) {
      ctx.workspace.saveCompileConfig(ctx.workspace.getProjectPath(), config)
    }
    ctx.notify.settingsChanged(config)
  })

  ipcMain.on(
    SettingsChannel.ProjectSettingsChanged,
    (_, patch: Partial<ProjectSettings>) => {
      ctx.workspace.updateProjectSettings(ctx.workspace.getProjectPath(), patch)
    }
  )
}
