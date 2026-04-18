import type { WorkbenchConfig } from '../../shared/types.js'
import { createWorkbenchApp } from './app.js'
import { installAppMenu } from '../menu/index.js'
import type { WorkbenchContext } from '../services/workbench-context.js'
import { createSettingsWindow, wireSettingsWindowEvents } from '../windows/settings-window/index.js'
import { loadWorkbenchSettings } from '../services/settings/index.js'

/**
 * Convenience launcher for the default full-featured app.
 * Use createWorkbenchApp() when you want to customize modules or window setup.
 */
export function launch(config: WorkbenchConfig = {}): void {
  createWorkbenchApp(config).start()
}

export function buildDefaultMenu(ctx: WorkbenchContext): void {
  installAppMenu(ctx)
}

export async function openSettingsWindow(ctx: Pick<WorkbenchContext, 'workbenchSettingsWindow' | 'mainWindow' | 'rendererDir' | 'notify'>): Promise<void> {
  if (!ctx.workbenchSettingsWindow || ctx.workbenchSettingsWindow.isDestroyed()) {
    ctx.workbenchSettingsWindow = await createSettingsWindow(ctx.mainWindow, ctx.rendererDir)
    wireSettingsWindowEvents(ctx.workbenchSettingsWindow, () => {
      ctx.workbenchSettingsWindow = null
    })
  }
  ctx.workbenchSettingsWindow.show()
  ctx.workbenchSettingsWindow.focus()
  ctx.notify.workbenchSettingsInit(ctx.workbenchSettingsWindow, {
    settings: loadWorkbenchSettings(),
  })
}
