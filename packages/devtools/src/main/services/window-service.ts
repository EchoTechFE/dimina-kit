import type { BrowserWindow } from 'electron'

/**
 * Owns every top-level BrowserWindow the workbench is responsible for.
 *
 * Callers should prefer this service over reading bare `mainWindow` /
 * `workbenchSettingsWindow` fields off `WorkbenchContext` — the latter
 * remain as @deprecated synchronized mirrors during the migration window.
 */
export interface WindowService {
  /** The primary devtools window. Created during app bootstrap. */
  readonly mainWindow: BrowserWindow
  /** Standalone workbench-settings BrowserWindow, or null when closed. */
  readonly settingsWindow: BrowserWindow | null
  /** Update the tracked settings window (null when closed/destroyed). */
  setSettingsWindow(win: BrowserWindow | null): void
  /** Close the settings window if it is open and clear the reference. */
  closeSettingsWindow(): void
  /** True when `webContentsId` belongs to the (alive) main window renderer. */
  isMainSender(webContentsId: number): boolean
  /** True when `webContentsId` belongs to the (alive) settings window renderer. */
  isSettingsWindowSender(webContentsId: number): boolean
}

export function createWindowService(mainWindow: BrowserWindow): WindowService {
  let settingsWin: BrowserWindow | null = null
  return {
    get mainWindow() {
      return mainWindow
    },
    get settingsWindow() {
      return settingsWin
    },
    setSettingsWindow(win) {
      settingsWin = win
    },
    closeSettingsWindow() {
      if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close()
      settingsWin = null
    },
    isMainSender(id) {
      return !mainWindow.isDestroyed() && mainWindow.webContents.id === id
    },
    isSettingsWindowSender(id) {
      return !!settingsWin && !settingsWin.isDestroyed() && settingsWin.webContents.id === id
    },
  }
}
