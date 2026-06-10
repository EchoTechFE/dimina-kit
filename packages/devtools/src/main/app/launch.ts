import { electronDeck as frameworkElectronDeck } from '@dimina-kit/electron-deck'
import type { WorkbenchAppConfig } from '../../shared/types.js'
import { createDevtoolsBackend } from '../runtime/devtools-backend.js'
import { installAppMenu } from '../menu/index.js'
import type { WorkbenchContext } from '../services/workbench-context.js'
import { createSettingsWindow, wireSettingsWindowEvents } from '../windows/settings-window/index.js'
import { loadWorkbenchSettings } from '../services/settings/index.js'

/**
 * Host-shell entry for the devtools app. Boots through the
 * `@dimina-kit/electron-deck` framework orchestrator (process lifecycle gate +
 * wire/trust) with the devtools {@link createDevtoolsBackend} supplying the full
 * runtime — the framework is the single entry. The instance builder
 * (`createDevtoolsRuntime`) is internal; hosts integrate via `launch(config)`,
 * passing `WorkbenchAppConfig` (incl. `onSetup`, `apiNamespaces`, `menuBuilder`, …).
 */
export function launch(config: WorkbenchAppConfig = {}): Promise<void> {
  return frameworkElectronDeck({ backend: createDevtoolsBackend(config) })
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
