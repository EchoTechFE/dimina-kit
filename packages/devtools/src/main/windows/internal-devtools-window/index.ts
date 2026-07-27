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
export interface InternalDevtoolsWindowOptions {
  /** Authority for "the app is quitting right now" (see app/lifecycle.ts).
   * During a real quit every window is closing for real — the controller's
   * habitual close-interception (preventDefault + hide) would CANCEL the
   * quit and leave the process alive with a hidden window nothing will ever
   * show again, so a truthy answer here lets the native close proceed. */
  isAppQuitting?: () => boolean
}

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
   * a window nobody can see," not "the attachment is gone." A subscriber
   * registering while the window is ALREADY visible gets the current host
   * replayed one microtask later (same catch-up contract as bridge-router's
   * `onServiceHostReady`) — consumers wired up after `open()` must not stay
   * stuck believing there is no host. Returns an unsubscribe. */
  onHostChanged(handler: (hostWc: WebContents | null) => void): () => void
}

export function createInternalDevtoolsWindow(
  target: BrowserWindow,
  opts?: InternalDevtoolsWindowOptions,
): InternalDevtoolsWindow {
  let win: BrowserWindow | null = null
  // The host WebContentsView, kept so open()/close paths can push the host
  // transition themselves (see notifyHostChanged's dedup comment).
  let hostView: WebContentsView | null = null
  const hostChangedHandlers = new Set<(hostWc: WebContents | null) => void>()
  // The host wc subscribers currently see (non-null only while the window is
  // visible) — the single value the late-subscriber catch-up replays.
  let currentHost: WebContents | null = null

  // A throwing handler must never stop the fan-out — console-forward's own
  // `sink(entry)` broadcast (console-forward/index.ts) uses the same
  // isolation for exactly this reason.
  //
  // Dedups on the TRANSITION, not the event count: this controller pushes
  // the transition explicitly at every point it performs one (open(), the
  // intercepted close, dispose/'closed'), AND the native 'show'/'hide'
  // handlers below may report the same transition again. The explicit push
  // is the authority — on real macOS the native events were observed
  // (instrumented-bundle trace against the live app) to fire for NEITHER
  // `show()`/`showInactive()` NOR `hide()`, which left every subscriber
  // permanently believing the window never opened; the events are kept only
  // as belt-and-suspenders for external show/hide paths.
  function notifyHostChanged(hostWc: WebContents | null): void {
    if (hostWc === currentHost) return
    currentHost = hostWc
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
    hostView = view
    const container = new View()
    container.addChildView(view)
    hostWindow.contentView = container
    resizeHostView(hostWindow, view)
    hostWindow.on('resize', () => resizeHostView(hostWindow, view))

    // Intercept the user-initiated close (title-bar button, Cmd+W) and hide
    // instead of destroy — see module doc for why destroying and rebuilding
    // this attachment cannot be made reliable. `dispose()` bypasses this via
    // `win.destroy()`, which Electron guarantees does NOT emit 'close'.
    // EXCEPT during a real app quit: preventDefault() on 'close' while the
    // app is quitting CANCELS the quit itself (Electron closes every window
    // as part of quit and aborts if any refuses), stranding the process with
    // a hidden window — let the native close proceed instead.
    hostWindow.on('close', (event) => {
      if (opts?.isAppQuitting?.()) return
      event.preventDefault()
      hostWindow.hide()
      // Push the transition ourselves — the native 'hide' event is not
      // reliable (see notifyHostChanged's dedup comment).
      notifyHostChanged(null)
    })
    // Any real destruction (quit-time close above, or dispose()'s destroy())
    // must both release the controller's handle and tell subscribers the
    // host is gone.
    hostWindow.on('closed', () => {
      if (win !== hostWindow) return
      win = null
      notifyHostChanged(null)
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
      // Push the transition ourselves — the native 'show' event is not
      // reliable (see notifyHostChanged's dedup comment); relying on it left
      // the mirrors permanently unsubscribed on real macOS.
      if (hostView) notifyHostChanged(hostView.webContents)
    },
    dispose() {
      if (!win) return
      const hostWindow = win
      // destroy() emits 'closed', whose handler above nulls `win` and
      // notifies subscribers — the fallback below only covers a window that
      // was somehow already destroyed without that handler having run.
      if (!hostWindow.isDestroyed()) hostWindow.destroy()
      if (win === hostWindow) {
        win = null
        notifyHostChanged(null)
      }
    },
    onHostChanged(handler) {
      hostChangedHandlers.add(handler)
      // Late-subscriber catch-up (see the interface doc): replayed a
      // microtask later, never synchronously, and re-validated at fire time —
      // an unsubscribe or a hide landing before the microtask must win.
      if (currentHost) {
        queueMicrotask(() => {
          if (!hostChangedHandlers.has(handler)) return
          if (!currentHost) return
          try { handler(currentHost) } catch (err) {
            console.warn('[internal-devtools-window] onHostChanged catch-up handler threw:', err instanceof Error ? err.message : String(err))
          }
        })
      }
      return () => { hostChangedHandlers.delete(handler) }
    },
  }
}
