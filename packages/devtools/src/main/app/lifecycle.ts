import { app, globalShortcut } from 'electron'

// Flips to `true` once Electron's `before-quit` fires — a real application
// quit (⌘Q / menu "Quit" / app.quit()) is underway. `before-quit` is emitted
// BEFORE each window's `close` event, so the main-window onClose handler can
// read this to tell "the whole app is exiting" apart from "the user closed a
// single project window" and avoid swallowing the quit.
//
// Deliberately a ONE-WAY latch: Electron emits no "quit was canceled" signal
// to reset on, and any heuristic reset (timers, window-created probes) risks
// flipping back to false DURING a real quit — which would re-arm the very
// close-interception this flag exists to disable and abort the quit. The
// cost of staying latched after a hypothetically-canceled quit (no in-repo
// cancel path exists; a renderer `beforeunload` could in principle create
// one) is a degraded-but-functional state, strictly cheaper than a broken
// quit.
let appIsQuitting = false

export function isAppQuitting(): boolean {
  return appIsQuitting
}

/**
 * `onBeforeQuit`: invoked synchronously, once per `before-quit`, while
 * Electron's main loop is still fully healthy — i.e. BEFORE `will-quit` and
 * any window/WebContentsView destruction. Callers use this to tear down
 * resources (child WebContentsViews, MessagePorts) that are unsafe to let
 * survive into Chromium's native shutdown sequence, where a JS `'destroyed'`
 * handler closing them can hit an already-torn-down native object. Isolated
 * like `host-toolbar-port-channel.ts`'s `invokeReadyHandler`: a throwing
 * callback must not stop `appIsQuitting` from flipping or escape as an
 * uncaught exception out of Electron's event dispatch.
 */
export function registerAppLifecycle(onBeforeQuit?: () => void): void {
  app.on('window-all-closed', () => {
    globalShortcut.unregisterAll()
    app.quit()
  })

  app.on('before-quit', () => {
    appIsQuitting = true
    globalShortcut.unregisterAll()
    try {
      onBeforeQuit?.()
    } catch (err) {
      console.error('[lifecycle] onBeforeQuit handler threw:', err)
    }
  })
}
