import type { BrowserWindow } from 'electron'

export function wireSettingsWindowEvents(
  win: BrowserWindow,
  onClosed: () => void,
): void {
  win.on('closed', () => {
    onClosed()
  })
}
