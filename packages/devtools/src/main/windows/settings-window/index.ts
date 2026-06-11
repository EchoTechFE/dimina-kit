import type { BrowserWindow } from 'electron'
import { createSettingsWindow } from './create.js'
import { wireSettingsWindowEvents } from './events.js'
import {
  loadWorkbenchSettings,
  type WorkbenchSettings,
} from '../../services/settings/index.js'

export { createSettingsWindow } from './create.js'
export { wireSettingsWindowEvents } from './events.js'

/**
 * Exactly what `openSettingsWindow` needs — its OWN narrow deps interface,
 * not a `Pick<WorkbenchContext, …>`: picking from the full context couples
 * this helper to the whole context type (and made the contract's old
 * `windows: object` pass-through promise unfulfillable). A full
 * `WorkbenchContext` satisfies this structurally, so assembly points pass
 * the context straight through.
 */
export interface OpenSettingsWindowDeps {
  /** Absolute path to the renderer dist directory (settings entry HTML). */
  rendererDir: string
  windows: {
    readonly mainWindow: BrowserWindow
    readonly settingsWindow: BrowserWindow | null
    setSettingsWindow(win: BrowserWindow | null): void
  }
  notify: {
    workbenchSettingsInit(
      window: BrowserWindow,
      payload: { settings: WorkbenchSettings },
    ): void
  }
}

/**
 * In-flight creation guard, keyed by the windows registry (the identity that
 * owns the `settingsWindow` slot). Overlapping `openSettingsWindow` calls
 * before the first creation lands must share ONE creation — without this,
 * both observe `settingsWindow === null` across the async construction
 * boundary, build two BrowserWindows, and the loser is orphaned (alive,
 * unreachable, never reused).
 */
const inFlightCreations = new WeakMap<
  OpenSettingsWindowDeps['windows'],
  Promise<BrowserWindow>
>()

async function getOrCreateSettingsWindow(
  deps: OpenSettingsWindowDeps,
): Promise<BrowserWindow> {
  const existing = deps.windows.settingsWindow
  if (existing && !existing.isDestroyed()) return existing

  const inFlight = inFlightCreations.get(deps.windows)
  if (inFlight) return inFlight

  const creation = (async () => {
    const win = await createSettingsWindow(deps.windows.mainWindow, deps.rendererDir)
    deps.windows.setSettingsWindow(win)
    wireSettingsWindowEvents(win, () => {
      // Electron delivers 'closed' asynchronously: a just-destroyed window's
      // late callback may arrive AFTER a successor was registered. Only the
      // CURRENT registration's own close may clear the slot — a stale
      // window's close must not drop a live successor.
      if (deps.windows.settingsWindow === win) {
        deps.windows.setSettingsWindow(null)
      }
    })
    return win
  })()
  inFlightCreations.set(deps.windows, creation)
  try {
    return await creation
  } finally {
    if (inFlightCreations.get(deps.windows) === creation) {
      inFlightCreations.delete(deps.windows)
    }
  }
}

/**
 * Open (or re-focus) the standalone workbench-settings window. Reuses the
 * live window when one is already registered; otherwise creates it, registers
 * it on the window service, and wires its `closed` cleanup. Concurrent calls
 * share a single in-flight creation (exactly one window; every caller still
 * gets the show/focus/snapshot semantics). Always shows + focuses, then
 * pushes the current settings snapshot into it.
 */
export async function openSettingsWindow(deps: OpenSettingsWindowDeps): Promise<void> {
  const win = await getOrCreateSettingsWindow(deps)
  win.show()
  win.focus()
  deps.notify.workbenchSettingsInit(win, {
    settings: loadWorkbenchSettings(),
  })
}
