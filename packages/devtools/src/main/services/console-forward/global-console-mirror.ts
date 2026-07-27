import type { WebContents } from 'electron'
import type { Disposable } from '@dimina-kit/electron-deck/main'
import type { ConsoleForwarder, GuestConsoleEntry } from './index.js'
import type { CdpSessionBroker } from '../cdp-session/index.js'
import { isFrontendSettled } from '../views/inject-when-ready.js'
import { createOpenGatedRelay } from './open-gated-relay.js'
import { injectViaCdp } from './cdp-inject.js'

/** Console levels safe to re-emit; anything else maps to 'log' — mirrors
 *  console-forward/index.ts's FORWARDABLE_LEVELS. */
const FORWARDABLE_LEVELS = new Set(['log', 'warn', 'error', 'info', 'debug'])

/**
 * Build the `executeJavaScript` source that re-emits one guest console entry
 * into the target wc's own console, tagged with its source layer. Args ride
 * as a JSON string and are re-parsed target-side — data, never code — same
 * discipline as console-forward/index.ts's buildForwardScript.
 */
function buildMirrorScript(entry: GuestConsoleEntry): string {
  const method = FORWARDABLE_LEVELS.has(entry.level ?? '') ? entry.level! : 'log'
  const tag = entry.source === 'render' ? '[render]' : '[service]'
  const argsJson = JSON.stringify(entry.args ?? [])
  return `(()=>{try{const a=JSON.parse(${JSON.stringify(argsJson)});console[${JSON.stringify(method)}](${JSON.stringify(tag)},...a)}catch(_){}})()`
}

/**
 * Mirror EVERY guest console entry (both service + render layers,
 * UNFILTERED — no isInternalLogMessage gating, see that module's doc for
 * why this mirror deliberately skips it) into `target`'s own console, but
 * ONLY while the standalone internal DevTools window is open.
 *
 * The subscription lifecycle is gated by `onHostChanged` (non-null hostWc =
 * window just opened/rebuilt, null = just closed) rather than subscribing
 * once for the whole app lifetime: each open re-subscribes to `forwarder`
 * with `{replay:true}`, draining its CURRENT history buffer into `target`
 * before continuing live, and each close disposes that subscription. This
 * is what makes opening (or reopening) the window always show recent
 * history — subscribing once at construction time (this module's earlier
 * design) captured the replay burst before any window could possibly be
 * open to receive it, silently losing it forever. `target` is the fixed
 * INSPECTED side (mainWindow.webContents, per
 * internal-devtools-window.ts's setDevToolsWebContents relationship) —
 * never the hostWc the signal carries; injecting into the front-end host
 * page would only ever reach that page's own invisible console.
 *
 * Reopen-dedup is handled by `createOpenGatedRelay` (real-machine e2e
 * confirmed a naive replay-on-every-open double-injects everything already
 * shown once, since Chromium's own console storage survives a DevTools
 * close — see that module's doc comment).
 */
export function createGlobalConsoleMirror(
  forwarder: Pick<ConsoleForwarder, 'subscribe'>,
  target: WebContents,
  onHostChanged: (handler: (hostWc: WebContents | null) => void) => () => void,
  opts: { broker: CdpSessionBroker },
): Disposable {
  function inject(entry: GuestConsoleEntry): boolean | Promise<boolean> {
    if (target.isDestroyed()) return false
    if (!isFrontendSettled(target)) return false
    let script: string
    try {
      script = buildMirrorScript(entry)
    } catch {
      return false
    }
    // Transport is CDP `Runtime.evaluate` over the shared debugger-session
    // broker — NEVER `target.executeJavaScript`: Electron's internal
    // ExecuteJavaScript RPC hangs FOREVER on a wc that is simultaneously the
    // inspected side of `setDevToolsWebContents` (the standalone debug
    // window) AND attached by an external CDP client (remote-debugging-port,
    // which bootstrap's setupCdpPort enables by default when unpackaged and
    // whenever cdp/mcp settings are on) — real-machine repro. The debugger
    // channel is unaffected. Report the real outcome (not fire-and-forget) —
    // createOpenGatedRelay only marks an entry permanently "injected" on a
    // confirmed `true`, and its inject timeout bounds any residual hang.
    return injectViaCdp(opts.broker, target, script, 'global-console-mirror')
  }

  return createOpenGatedRelay<GuestConsoleEntry, WebContents>(
    onHostChanged,
    (sink, opts2) => forwarder.subscribe(sink, opts2),
    inject,
  )
}
