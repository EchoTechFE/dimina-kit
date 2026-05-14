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
export function launch(config: WorkbenchConfig = {}): Promise<void> {
  return createWorkbenchApp(config).start()
}

export function buildDefaultMenu(ctx: WorkbenchContext): void {
  installAppMenu(ctx)
}

export async function openSettingsWindow(ctx: Pick<WorkbenchContext, 'workbenchSettingsWindow' | 'mainWindow' | 'rendererDir' | 'notify' | 'windows'>): Promise<void> {
  if (!ctx.workbenchSettingsWindow || ctx.workbenchSettingsWindow.isDestroyed()) {
    const win = await createSettingsWindow(ctx.mainWindow, ctx.rendererDir)
    ctx.workbenchSettingsWindow = win
    ctx.windows.setSettingsWindow(win)
    wireSettingsWindowEvents(win, () => {
      ctx.workbenchSettingsWindow = null
      ctx.windows.setSettingsWindow(null)
    })
  }
  ctx.workbenchSettingsWindow.show()
  ctx.workbenchSettingsWindow.focus()
  ctx.notify.workbenchSettingsInit(ctx.workbenchSettingsWindow, {
    settings: loadWorkbenchSettings(),
  })
}
