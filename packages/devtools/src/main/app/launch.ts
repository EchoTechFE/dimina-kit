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

export async function openSettingsWindow(ctx: Pick<WorkbenchContext, 'rendererDir' | 'notify' | 'windows'>): Promise<void> {
  let win = ctx.windows.settingsWindow
  if (!win || win.isDestroyed()) {
    win = await createSettingsWindow(ctx.windows.mainWindow, ctx.rendererDir)
    ctx.windows.setSettingsWindow(win)
    wireSettingsWindowEvents(win, () => {
      ctx.windows.setSettingsWindow(null)
    })
  }
  win.show()
  win.focus()
  ctx.notify.workbenchSettingsInit(win, {
    settings: loadWorkbenchSettings(),
  })
}
