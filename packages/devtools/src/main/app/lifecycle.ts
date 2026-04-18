import { app, globalShortcut } from 'electron'

export function registerAppLifecycle(): void {
  app.on('window-all-closed', () => {
    globalShortcut.unregisterAll()
    app.quit()
  })

  app.on('before-quit', () => {
    globalShortcut.unregisterAll()
  })
}
