import type { WebContents } from 'electron'
import { BrowserWindow, View, WebContentsView } from 'electron'

/**
 * Standalone (non-dock) DevTools window for the whole Electron app — the
 * independent floating CDP debug panel's host window. Unlike the right-panel
 * CDP (`native-simulator-devtools-host.ts`, which re-points at a swappable
 * service-host wc via a reconciler-driven overlay), `target` here is the main
 * window's own webContents and never swaps, so this controller needs none of
 * that machinery: just a plain window with a WebContentsView filling it as
 * the DevTools front-end host.
 *
 * The window + its `setDevToolsWebContents` attachment are built ONCE (on
 * the first `open()`) and never rebuilt afterward — the close button hides
 * rather than destroys. This is deliberate, not an oversight: real-repro
 * diagnostic instrumentation + a source-level Electron/Chromium
 * investigation this session established that destroying and rebuilding
 * this attachment on every close/reopen cycle cannot be made reliable.
 * `closeDevTools()` is effectively a no-op on the `setDevToolsWebContents`
 * external-front-end path (Electron's `InspectableWebContents::CloseDevTools`
 * only does real cleanup when `managed_devtools_web_contents_` is set, which
 * external attachments never populate) — the ONLY authoritative "detached"
 * signal, `'devtools-closed'`, is tied to the OLD front-end host's underlying
 * `content::WebContents` C++ object being destroyed, which was observed
 * (real timestamped log, this session) to take 20+ seconds — the same
 * order of magnitude as this app's own independently-discovered
 * `'close'`-to-`'closed'` BrowserWindow teardown lag. This is a long-standing,
 * unresolved upstream behavior (electron/electron#14095, #17168, #27110,
 * #37356), not something fixable from this module. Electron's own
 * `setDevToolsWebContents` documentation example builds its host window
 * exactly once for the app's lifetime and never rebuilds it — reusing the
 * same host sidesteps the entire bug class instead of chasing a fast
 * "really detached now" signal that does not exist.
 */
export interface InternalDevtoolsWindow {
  /** Create (on the very first call) and show/focus the window, attaching
   * its DevTools front-end host to `target`'s DevTools exactly once. Every
   * later call just re-shows/focuses the SAME window and host — the
   * underlying DevTools attachment is never rebuilt (see module doc). */
  open(): void
  /** Actually destroy the window and release the DevTools attachment.
   * Distinct from the user closing the window (which only hides it) — this
   * is for real app-level teardown. Safe to call even if `open()` was never
   * called. */
  dispose(): void
  /** Subscribe to the front-end host's visibility: fires with the host wc
   * when the window is built (first `open()`) or shown again, and with null
   * when the window is hidden (user close) or destroyed (`dispose()`).
   * Global CDP consumers (network-forward, service-console) gate their
   * dispatch target here — hidden means "stop spending work mirroring into
   * a window nobody can see," not "the attachment is gone." Returns an
   * unsubscribe. */
  onHostChanged(handler: (hostWc: WebContents | null) => void): () => void
}

export function createInternalDevtoolsWindow(target: BrowserWindow): InternalDevtoolsWindow {
  let win: BrowserWindow | null = null
  const hostChangedHandlers = new Set<(hostWc: WebContents | null) => void>()

  // A throwing handler must never stop the fan-out — console-forward's own
  // `sink(entry)` broadcast (console-forward/index.ts) uses the same
  // isolation for exactly this reason.
  function notifyHostChanged(hostWc: WebContents | null): void {
    for (const handler of [...hostChangedHandlers]) {
      try { handler(hostWc) } catch (err) {
        console.warn('[internal-devtools-window] onHostChanged handler threw, other handlers still ran:', err instanceof Error ? err.message : String(err))
      }
    }
  }

  function resizeHostView(hostWindow: BrowserWindow, view: WebContentsView): void {
    try {
      const [width, height] = hostWindow.getContentSize()
      view.setBounds({ x: 0, y: 0, width, height })
    } catch { /* window mid-construction / torn down — next resize event re-fires */ }
  }

  // Builds the window + host + DevTools attachment exactly once. A second
  // call (win already alive) is a no-op — see module doc for why this
  // attachment is never rebuilt.
  function buildOnce(): void {
    if (win) return
    const hostWindow = new BrowserWindow({
      width: 1000,
      height: 700,
      title: '全局调试',
      show: false,
    })
    win = hostWindow

    // The window's default `contentView` is a bare WebContentsView tied to
    // its own (never-loaded) webContents, not a container that accepts
    // children — mirror main-window/create.ts's pattern: wrap it in a fresh
    // `View` so the host can be added as a child.
    const view = new WebContentsView()
    const container = new View()
    container.addChildView(view)
    hostWindow.contentView = container
    resizeHostView(hostWindow, view)
    hostWindow.on('resize', () => resizeHostView(hostWindow, view))

    // Intercept the user-initiated close (title-bar button, Cmd+W) and hide
    // instead of destroy — see module doc for why destroying and rebuilding
    // this attachment cannot be made reliable. `dispose()` bypasses this via
    // `win.destroy()`, which Electron guarantees does NOT emit 'close'.
    hostWindow.on('close', (event) => {
      event.preventDefault()
      hostWindow.hide()
    })
    hostWindow.on('hide', () => notifyHostChanged(null))
    hostWindow.on('show', () => notifyHostChanged(view.webContents))

    if (!target.webContents.isDestroyed()) {
      target.webContents.setDevToolsWebContents(view.webContents)
      target.webContents.openDevTools({ mode: 'detach', activate: false })
    }
  }

  return {
    open() {
      buildOnce()
      // Mirrors main-window/create.ts's exact test-mode rule: `showInactive()`
      // makes the window visible without activating it (and thus never gives
      // it OS-level focus), so e2e runs opening this window never steal
      // foreground focus from whatever the developer running the suite has
      // open. Production always wants a real show()+focus() — this is the
      // one button click that's supposed to bring the debug window forward.
      if (process.env.NODE_ENV === 'test') {
        win!.showInactive()
      } else {
        win!.show()
        win!.focus()
      }
    },
    dispose() {
      if (!win) return
      if (!win.isDestroyed()) win.destroy()
      win = null
      notifyHostChanged(null)
    },
    onHostChanged(handler) {
      hostChangedHandlers.add(handler)
      return () => { hostChangedHandlers.delete(handler) }
    },
  }
}
