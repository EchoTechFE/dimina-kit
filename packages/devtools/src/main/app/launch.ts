import { electronDeck as frameworkElectronDeck } from '@dimina-kit/electron-deck'
import type { MenuContext, WorkbenchAppConfig } from '../../shared/types.js'
import { createDevtoolsBackend } from '../runtime/devtools-backend.js'
import { installAppMenu } from '../menu/index.js'

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

export function buildDefaultMenu(ctx: MenuContext): void {
  installAppMenu(ctx)
}

// The implementation lives with the settings-window domain module and takes
// its own narrow `OpenSettingsWindowDeps` (a full WorkbenchContext satisfies
// it structurally). Re-exported here so the public barrel path is unchanged.
// Contract holders should prefer `ctx.openSettings()` / `runtime.openSettings()`.
export { openSettingsWindow } from '../windows/settings-window/index.js'
export type { OpenSettingsWindowDeps } from '../windows/settings-window/index.js'
