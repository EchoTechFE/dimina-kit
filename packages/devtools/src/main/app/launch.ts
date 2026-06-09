import { electronDeck as frameworkElectronDeck } from '@dimina-kit/electron-deck'
import type { WorkbenchAppConfig } from '../../shared/types.js'
import { createDevtoolsBackend } from '../runtime/devtools-backend.js'
import { installAppMenu } from '../menu/index.js'
import type { WorkbenchContext } from '../services/workbench-context.js'
import { createSettingsWindow, wireSettingsWindowEvents } from '../windows/settings-window/index.js'
import { loadWorkbenchSettings } from '../services/settings/index.js'

/**
 * Convenience launcher for the default full-featured app.
 *
 * v2: boots through the `@dimina-kit/electron-deck` framework orchestrator (process
 * lifecycle gate + wire/trust) with the devtools {@link createDevtoolsBackend}
 * supplying the full runtime — the framework is now the single entry. The
 * instance builder (`createDevtoolsRuntime`) is internal; hosts integrate via
 * `workbench(config)` / `launch(config)`.
 */
export function launch(config: WorkbenchAppConfig = {}): Promise<void> {
  return frameworkElectronDeck({}, { backend: createDevtoolsBackend(config) })
}

/**
 * Declarative host-shell entry. Identical to {@link launch} — both boot through
 * the `@dimina-kit/electron-deck` framework with the devtools backend; hosts use
 * this name when integrating (config = `WorkbenchAppConfig`, incl. `onSetup`,
 * `apiNamespaces`, `menuBuilder`, …).
 */
export const workbench = launch

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
