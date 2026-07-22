/**
 * Dedicated, NETWORK-ONLY outbound CDP gate for the standalone internal
 * (app-wide) DevTools window's front-end.
 *
 * ── Why a SEPARATE gate from elements-forward ───────────────────────────────
 * elements-forward's `InspectorFrontendHost.sendMessageToBackend` hook
 * (see ../elements-forward/index.ts) ALSO intercepts DOM/CSS/Overlay commands
 * and redirects them to the active render guest — correct for the RIGHT-panel
 * CDP (which inspects the service host but wants Elements to reflect the
 * render guest's live DOM), but WRONG for the global window: its Elements/
 * Sources/Console should inspect `mainWindow` NATIVELY, with zero redirection.
 * Installing the full elements-forward gate here would silently reroute the
 * global window's Elements panel to the wrong target. This module intercepts
 * ONLY `Network.getResponseBody` / `Network.getRequestPostData` for
 * `dimina:sim:` virtual requestIds; every other command (including all
 * DOM/CSS/Overlay/Runtime/Debugger/…) passes straight through untouched.
 *
 * ── Mechanism (same two-way poll bridge as elements-forward) ───────────────
 * front-end → main: wrap `InspectorFrontendHost.sendMessageToBackend`; a
 * matching command is pushed onto `globalThis.__diminaGlobalNetworkOutbound`
 * and NOT forwarded to the original channel; everything else calls through.
 * main → front-end: answer via `window.DevToolsAPI.dispatchMessage` (chunked
 * for large bodies), reusing the same transport network-forward's primary
 * sink uses.
 *
 * Degradation: hook unavailable / host destroyed / a lookup rejects → the
 * command settles with the standard CDP not-found error (same as an unknown
 * id would get from the real backend) — never throws, never blocks anything
 * else in the window.
 */
import type { WebContents } from 'electron'
import { isFrontendSettled } from '../views/inject-when-ready.js'
import type { NetworkBodyProvider } from './index.js'
import { VIRTUAL_REQUEST_ID_PREFIX } from './index.js'
import { createFrontendReplyChannel, answerNetworkBodyCommand, drainOutboundBatch } from './frontend-dispatch.js'

/** The only two Network.* commands this gate ever intercepts. */
const NETWORK_BODY_METHODS: readonly string[] = ['Network.getResponseBody', 'Network.getRequestPostData']

/** One drained front-end command awaiting an answer from the body cache. */
interface OutboundCommand {
  id: number | null
  method: string
  params: unknown
  sessionId: string | null
}

const DRAIN_INTERVAL_MS = 150

/**
 * The JS injected into the DevTools front-end realm. Idempotent (sentinel
 * guard, distinct from elements-forward's — the two gates coexist on
 * DIFFERENT host wcs and never share a front-end, but the sentinel is scoped
 * defensively anyway).
 */
export function buildNetworkOnlyHookScript(): string {
  const netMethods = JSON.stringify(NETWORK_BODY_METHODS)
  const vprefix = JSON.stringify(VIRTUAL_REQUEST_ID_PREFIX)
  return `(function(){try{
    if (globalThis.__diminaGlobalNetworkHookInstalled) return 'already';
    var OUT = (globalThis.__diminaGlobalNetworkOutbound = globalThis.__diminaGlobalNetworkOutbound || []);
    var NET_METHODS = ${netMethods};
    var VPREFIX = ${vprefix};
    function isNetworkBody(m){
      if (!m || !m.method) return false;
      if (NET_METHODS.indexOf(m.method) < 0) return false;
      return !!(m.params && typeof m.params.requestId === 'string' && m.params.requestId.indexOf(VPREFIX) === 0);
    }
    var IFH = globalThis.InspectorFrontendHost;
    if (IFH && typeof IFH.sendMessageToBackend === 'function' && !IFH.__diminaGlobalNetworkWrapped){
      var origSend = IFH.sendMessageToBackend.bind(IFH);
      IFH.sendMessageToBackend = function(message){
        try {
          var m = (typeof message === 'string') ? JSON.parse(message) : message;
          if (isNetworkBody(m)){
            OUT.push({ id: (m && typeof m.id === 'number') ? m.id : null,
              method: m.method, params: m.params || {},
              sessionId: (m && m.sessionId) ? m.sessionId : null });
            return;
          }
        } catch(_){ /* fall through to original on any parse hiccup */ }
        return origSend(message);
      };
      IFH.__diminaGlobalNetworkWrapped = true;
      globalThis.__diminaGlobalNetworkHookInstalled = true;
      return 'installed';
    }
    return 'partial';
  }catch(e){ return 'error:' + (e && e.message); }})()`
}

function buildReconcileScript(): string {
  return `(function(){`
    + `var status; try { status = ${buildNetworkOnlyHookScript()}; } catch(e){ status = 'error:'+(e&&e.message); }`
    + `var batch = []; try { if (globalThis.__diminaGlobalNetworkOutbound) batch = globalThis.__diminaGlobalNetworkOutbound.splice(0); } catch(_){}`
    + `return { status: status, batch: batch };`
    + `})()`
}

/**
 * Install the gate on `hostWc` (the global window's front-end host).
 * Returns a disposer that stops the reconcile loop. Best-effort throughout —
 * never throws, degrades to CDP not-found on any failure.
 */
export function installGlobalNetworkBodyGate(hostWc: WebContents, bodies: NetworkBodyProvider): () => void {
  let disposed = false
  let reconcileTimer: ReturnType<typeof setInterval> | null = null
  const reply = createFrontendReplyChannel(hostWc, () => disposed)

  function handleOutbound(batch: unknown): void {
    drainOutboundBatch<OutboundCommand>(batch, (cmd) => answerNetworkBodyCommand(cmd, bodies, reply))
  }

  reconcileTimer = setInterval(() => {
    if (disposed || hostWc.isDestroyed()) { stop(); return }
    if (!isFrontendSettled(hostWc)) return
    hostWc
      .executeJavaScript(buildReconcileScript())
      .then((res: unknown) => {
        if (disposed) return
        const r = (res ?? {}) as { batch?: unknown }
        handleOutbound(r.batch)
      })
      .catch(() => { /* booting / navigating / torn-down — retried next tick */ })
  }, DRAIN_INTERVAL_MS)

  function stop(): void {
    disposed = true
    if (reconcileTimer) { clearInterval(reconcileTimer); reconcileTimer = null }
  }

  return stop
}
