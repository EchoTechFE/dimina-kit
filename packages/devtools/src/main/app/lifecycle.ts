import { app, globalShortcut } from 'electron'

// Flips to `true` once Electron's `before-quit` fires — a real application
// quit (⌘Q / menu "Quit" / app.quit()) is underway. `before-quit` is emitted
// BEFORE each window's `close` event, so the main-window onClose handler can
// read this to tell "the whole app is exiting" apart from "the user closed a
// single project window" and avoid swallowing the quit.
let appIsQuitting = false

export function isAppQuitting(): boolean {
  return appIsQuitting
}

export function registerAppLifecycle(): void {
  app.on('window-all-closed', () => {
    globalShortcut.unregisterAll()
    app.quit()
  })

  app.on('before-quit', () => {
    appIsQuitting = true
    globalShortcut.unregisterAll()
  })
}
