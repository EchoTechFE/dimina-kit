/**
 * Elements-panel forwarding — reflect the ACTIVE RENDER GUEST's live DOM tree in
 * the right-panel Chrome DevTools front-end, which natively inspects the
 * service-host (logic layer).
 *
 * ── Mechanism (no preload) ───────────────────────────────────────────────────
 * The DevTools front-end is a `devtools://` page with NO dimina preload, so we
 * drive it through the same two-way poll bridge the network-forward path uses:
 *   • front-end → main : we wrap `InspectorFrontendHost.sendMessageToBackend` in
 *     the front-end realm — the ONE outbound CDP gate every injected-panel
 *     feature routes through (`routeOutboundCommand` is the single decision
 *     table). Commands whose method is in the RENDER domain set
 *     (DOM/CSS/Overlay/DOMSnapshot/DOMDebugger), plus `Network.getResponseBody`
 *     / `Network.getRequestPostData` for `dimina:sim:` virtual requestIds
 *     (which only the network forwarder's prefetch cache can answer — the
 *     natively-inspected service host has never heard of them), are NOT passed
 *     to the original embedder channel — they're pushed onto
 *     `globalThis.__diminaElementsOutbound` tagged with their route and main
 *     drains that array (splice) on a poll. EVERY OTHER method
 *     (Runtime/Console/Page/Target/Emulation/…) calls through to the original, so
 *     the service-host inspection (Console, Sources) and crucially the safe-area
 *     `Emulation.setSafeAreaInsetsOverride` are untouched.
 *   • main → front-end : we re-inject responses + render-side EVENTS via
 *     `window.DevToolsAPI.dispatchMessage(json)` (chunked for large payloads —
 *     `DOM.getDocument` can be big — mirroring network-forward/index.ts).
 *
 * ── Render-guest CDP session (via the shared broker) ─────────────────────────
 * `webContents.debugger` is single-owner per wc, so this and every other
 * feature that needs a render guest's session (safe-area, render-inspect,
 * network-forward) `acquire()` a lease from the shared `CdpSessionBroker`
 * (see cdp-session/index.ts) instead of each hand-rolling its own attach/
 * reuse/detach bookkeeping — that duplication used to mean whichever module
 * happened to attach first was the de facto owner, and any other module's
 * `detach()` could steal the session out from under the others. The broker is
 * the single owner of "who attached, who may detach"; `DOM.enable`/
 * `CSS.enable`/`Overlay.enable` never touch the safe-area `Emulation`
 * override, so sharing a session this way is purely additive.
 *
 * ── Staleness (active-guest, NOT a generation counter) ───────────────────────
 * A response/event is honoured only while its originating guest is STILL the
 * active render guest — resolved fresh from the bridge per check (`isActiveWcId`),
 * not snapshotted. So a late response or stray render EVENT from a guest that is
 * no longer active is dropped (its in-flight command id is settled with an error
 * so the front-end never leaks a pending request, and stale nodes never bleed into
 * the new tree); and switching away and BACK to a previously-wired guest RESUMES
 * its forwarding (a snapshot would strand it).
 *
 * ── Degradation ──────────────────────────────────────────────────────────────
 * Hook unavailable / `DevToolsAPI` missing / no active guest → routing is simply
 * inert; the Elements panel falls back to the front-end's native service-host
 * DOM (the prior behaviour). Everything is try/catch + feature-detect + bounded
 * polling: it never throws, never blocks, never disturbs Console/Network/safe-area.
 *
 * This is a production feature (no env gate, default on for the native simulator).
 * The routing table (below) is self-contained; the front-end dispatch transport
 * (`buildChunkedDispatchScript` + its size constants) is shared with
 * network-forward via `../network-forward/frontend-dispatch.js` so the two
 * can never drift on the chunk-continuation protocol.
 */
import type { WebContents } from 'electron'
import type { ConnectionRegistry } from '@dimina-kit/electron-deck/main'
import type { BridgeRouterHandle, RenderEvent } from '../../ipc/bridge-router.js'
import { isFrontendSettled } from '../views/inject-when-ready.js'
import { VIRTUAL_REQUEST_ID_PREFIX, type NetworkBodyProvider } from '../network-forward/index.js'
import { buildSingleDispatchScript, createFrontendReplyChannel, answerNetworkBodyCommand, drainOutboundBatch } from '../network-forward/frontend-dispatch.js'
import { createCdpSessionBroker, type CdpSessionBroker, type CdpSessionLease } from '../cdp-session/index.js'

// ── routing table (pure, testable) ───────────────────────────────────────────

/**
 * Which target a front-end CDP command is routed to.
 *  render  — the active render guest's debugger (the Elements tree).
 *  network — the network forwarder's prefetch cache (body/post-data lookups
 *            for `dimina:sim:` virtual requestIds that only exist there).
 *  service — the original embedder channel (the service host the front-end
 *            natively inspects).
 */
export type CdpRoute = 'render' | 'network' | 'service'

/**
 * CDP domains that target the RENDER GUEST'S document tree. A command in one of
 * these is intercepted and sent to the active render guest's debugger instead of
 * the service host the front-end nominally inspects.
 */
export const RENDER_DOMAIN_PREFIXES: readonly string[] = [
  'DOM.',
  'CSS.',
  'Overlay.',
  'DOMSnapshot.',
  'DOMDebugger.',
]

/**
 * Decide where a front-end CDP `method` is routed.
 *
 *  render  → DOM./CSS./Overlay./DOMSnapshot./DOMDebugger.  (the Elements tree)
 *  service → EVERYTHING ELSE, and in particular:
 *    • Emulation.*  — RED LINE: routing this to the render guest would let the
 *      front-end overwrite the safe-area service's `setSafeAreaInsetsOverride`.
 *      It MUST stay on the service-host inspection path (pass-through).
 *    • Runtime./Console./Debugger./Network./Page./Target./Input./Profiler./Log.
 *      — the service host owns these; leave them on the original channel.
 *
 * Pure (no I/O). The hook script inlines an equivalent prefix test driven by the
 * same `RENDER_DOMAIN_PREFIXES` literal, so the two cannot silently drift.
 */
export function routeByDomain(method: string): CdpRoute {
  for (const prefix of RENDER_DOMAIN_PREFIXES) {
    if (method.startsWith(prefix)) return 'render'
  }
  return 'service'
}

/** True for an event method we re-inject from the render guest into the panel. */
export function isRenderEventMethod(method: string): boolean {
  return routeByDomain(method) === 'render'
}

/**
 * The Network commands answered from the network forwarder's prefetch cache
 * when they target a virtual requestId. Only these two: they're the panel's
 * body/post-data round-trips. Every other Network.* stays on the service path
 * (a virtual id there errors exactly like an unknown id would — harmless).
 */
export const NETWORK_BODY_METHODS: readonly string[] = [
  'Network.getResponseBody',
  'Network.getRequestPostData',
]

/**
 * Full outbound routing decision — the SINGLE authority for where a front-end
 * CDP command goes. `routeByDomain` covers the method-only render split; this
 * adds the params-dependent network split. The hook script inlines an
 * equivalent test driven by the same literals, so the two cannot drift.
 *
 * A non-string / missing requestId routes to 'service': only the
 * `dimina:sim:` namespace is ours to answer, and the real backend is the
 * correct authority for its own ids.
 */
export function routeOutboundCommand(method: string, params: unknown): CdpRoute {
  if (routeByDomain(method) === 'render') return 'render'
  if (NETWORK_BODY_METHODS.includes(method)) {
    const requestId = (params as { requestId?: unknown } | null | undefined)?.requestId
    if (typeof requestId === 'string' && requestId.startsWith(VIRTUAL_REQUEST_ID_PREFIX)) {
      return 'network'
    }
  }
  return 'service'
}

// ── front-end injection (the front-end → main half of the bridge) ────────────

/**
 * The JS injected into the DevTools front-end realm. Idempotent (sentinel guard).
 * Wraps `InspectorFrontendHost.sendMessageToBackend` — the ONE outbound CDP
 * gate for every command the front-end emits. A command that routes 'render'
 * or 'network' (same decision table as {@link routeOutboundCommand}) is pushed
 * onto `globalThis.__diminaElementsOutbound` tagged with its route and NOT
 * forwarded to the original embedder channel (main answers it — from the
 * render guest or the network prefetch cache respectively); every other
 * command calls through to the original (service-host path).
 *
 * Returns `'installed'` / `'already'` on success, `'partial'` while the embedder
 * global is not yet present (so the caller retries), `'error:…'` on a real fault.
 */
export function buildElementsHookScript(): string {
  const prefixes = JSON.stringify(RENDER_DOMAIN_PREFIXES)
  const netMethods = JSON.stringify(NETWORK_BODY_METHODS)
  const vprefix = JSON.stringify(VIRTUAL_REQUEST_ID_PREFIX)
  return `(function(){try{
    if (globalThis.__diminaElementsHookInstalled) return 'already';
    var OUT = (globalThis.__diminaElementsOutbound = globalThis.__diminaElementsOutbound || []);
    var PREFIXES = ${prefixes};
    var NET_METHODS = ${netMethods};
    var VPREFIX = ${vprefix};
    function isRender(method){
      if (!method) return false;
      for (var i=0;i<PREFIXES.length;i++){ if (method.indexOf(PREFIXES[i])===0) return true; }
      return false;
    }
    function routeOf(m){
      if (!m || !m.method) return 'service';
      if (isRender(m.method)) return 'render';
      if (NET_METHODS.indexOf(m.method) >= 0 && m.params
          && typeof m.params.requestId === 'string'
          && m.params.requestId.indexOf(VPREFIX) === 0) return 'network';
      return 'service';
    }
    var IFH = globalThis.InspectorFrontendHost;
    if (IFH && typeof IFH.sendMessageToBackend === 'function' && !IFH.__diminaElementsWrapped){
      var origSend = IFH.sendMessageToBackend.bind(IFH);
      IFH.sendMessageToBackend = function(message){
        try {
          var m = (typeof message === 'string') ? JSON.parse(message) : message;
          var route = routeOf(m);
          if (route !== 'service'){
            // Intercept: hand it to main to answer (render guest / network
            // cache). Do NOT call the original embedder channel — the service
            // host either has the wrong tree or has never heard of the id.
            OUT.push({ id: (m && typeof m.id === 'number') ? m.id : null,
              method: m.method, params: m.params || {},
              sessionId: (m && m.sessionId) ? m.sessionId : null,
              route: route });
            return;
          }
        } catch(_){ /* fall through to original on any parse hiccup */ }
        return origSend(message);
      };
      IFH.__diminaElementsWrapped = true;
      globalThis.__diminaElementsHookInstalled = true;
      return 'installed';
    }
    return 'partial';
  }catch(e){ return 'error:' + (e && e.message); }})()`
}

/**
 * One reconcile tick run in the front-end realm: idempotently (re)install the
 * hook AND drain the outbound queue in a SINGLE round-trip. The front-end's
 * `globalThis` is wiped on every devtools (re)load (service-host pool swap on a
 * hot-reload respawn re-opens DevTools and re-bootstraps the front-end), so the
 * hook must be re-asserted continuously — not once on `dom-ready`. Returns
 * `{ status, batch }`: `status` is `'installed'` the tick we (re)wrap a freshly
 * loaded front-end (the caller re-primes + re-pulls so Elements snaps back to the
 * render guest), `'already'` once it is in place, `'partial'` while the embedder
 * global has not appeared yet. `batch` is the drained command queue.
 */
function buildReconcileScript(): string {
  return `(function(){`
    + `var status; try { status = ${buildElementsHookScript()}; } catch(e){ status = 'error:'+(e&&e.message); }`
    + `var batch = []; try { if (globalThis.__diminaElementsOutbound) batch = globalThis.__diminaElementsOutbound.splice(0); } catch(_){}`
    + `return { status: status, batch: batch };`
    + `})()`
}

// ── main → front-end dispatch (shared transport with network-forward) ───────

/** Script that nudges the front-end to discard its document and lazily re-pull. */
function buildDocumentUpdatedScript(): string {
  const msg = JSON.stringify({ method: 'DOM.documentUpdated', params: {} })
  return buildSingleDispatchScript(msg)
}

// ── deps ─────────────────────────────────────────────────────────────────────

export interface ElementsForwardDeps {
  /** The wc hosting the right-panel Chrome DevTools FRONT-END (injection target). */
  devtoolsWc: WebContents
  /** Router handle — resolves the active render guest + render-event stream. */
  bridge: BridgeRouterHandle
  /**
   * The app whose active render guest we route to. `undefined` means "the
   * router's current app" (resolved fresh on every use, like the safe-area /
   * devtools-follow paths) — what the wire-up passes.
   */
  appId?: string
  /**
   * Optional connection registry. When present, the devtools front-end wc's
   * own `stop` teardown is routed through `connections.acquire(wc).own(cleanup)`
   * so it fires deterministically on wc destroy / connection reset — replacing
   * the bespoke `wc.once('destroyed', cleanup)` hook. Optional so existing
   * callers compile unchanged; absent → the `once('destroyed')` fallback is
   * used. Also threaded into the PRIVATE fallback broker (see `broker` below)
   * when no shared broker is supplied, so that broker's own render-guest
   * wc-destroy tracking is connection-routed too.
   */
  connections?: ConnectionRegistry
  /**
   * Answers intercepted `Network.getResponseBody` / `Network.getRequestPostData`
   * lookups for `dimina:sim:` virtual requestIds (the network forwarder's
   * prefetch cache). Absent → those commands settle with the standard CDP
   * not-found error, the same answer the mis-routed service-host backend gave.
   */
  network?: NetworkBodyProvider
  /**
   * Shared CDP session broker (see cdp-session/index.ts) that owns every
   * render-guest debugger session's attach/detach lifecycle — safe-area,
   * render-inspect and network-forward acquire leases from the same instance.
   * Absent → a private broker is created and owned for this call's lifetime
   * (torn down on `stop()`), so existing standalone callers/tests compile and
   * behave unchanged, just without cross-module session sharing.
   */
  broker?: CdpSessionBroker
}

/** One drained front-end command awaiting routing (render guest / network cache). */
interface OutboundCommand {
  id: number | null
  method: string
  params: unknown
  sessionId: string | null
  /** Routing tag stamped by the hook script; absent on render (legacy) payloads. */
  route?: string
}

// Reconcile cadence: each tick re-asserts the hook (idempotent) and drains the
// outbound queue. Fast enough that a freshly reloaded front-end is re-hooked
// within a tick, cheap because the install script short-circuits to 'already'.
const DRAIN_INTERVAL_MS = 150

/**
 * Install Elements forwarding on a DevTools front-end host wc. Returns a
 * disposer (`stop`) that clears timers, unsubscribes render events, releases
 * every broker lease this call acquired, and — only when no `deps.broker` was
 * supplied (this call owns its private broker) — disposes that broker too
 * (which detaches ONLY the sessions it self-attached). When `deps.broker` IS
 * supplied (the shared, app-wide instance), `stop()` never disposes it: other
 * consumers may still be using it.
 *
 * Best-effort + defensive throughout: a destroyed wc ends the feature; every
 * executeJavaScript / sendCommand is wrapped so a torn-down guest never throws
 * and an in-flight command always settles (we dispatch an error back rather than
 * leaving the front-end pending).
 */
export function installElementsForward(deps: ElementsForwardDeps): () => void {
  const { devtoolsWc, bridge } = deps
  // Own (and tear down on stop()) a private broker only when the caller didn't
  // supply a shared one — see ElementsForwardDeps.broker.
  const ownsBroker = !deps.broker
  const broker = deps.broker ?? createCdpSessionBroker({ connections: deps.connections })
  let disposed = false
  // A single self-healing loop drives BOTH hook (re)install and outbound drain;
  // it never self-terminates so a front-end reload (respawn) is re-hooked.
  let reconcileTimer: ReturnType<typeof setInterval> | null = null
  // Teardown that can only be wired AFTER the subscriptions below exist (render
  // events, the dom-ready listener, the connection 'closed' sub). `stop()` runs it
  // so EVERY teardown entry point — internal wc-destroy detection, the connection
  // 'closed'/'destroyed' handler, and the returned disposer — does the SAME full,
  // idempotent cleanup. Without this, a wc-destroy that reaches `stop()` directly
  // would leave the render-event subscription (and dom-ready listener) dangling.
  let lateCleanup: (() => void) | null = null

  // Staleness is keyed on the CURRENT active render guest, resolved fresh from the
  // bridge per check — NOT a generation snapshot. An event/response is honoured
  // only while its originating guest is still the active one, so switching away
  // and BACK to a previously-wired guest RESUMES its forwarding (a snapshot would
  // strand it forever). It also means destroying some OTHER (non-active) guest
  // never stales the active guest's in-flight commands.
  const isActiveWcId = (id: number): boolean => {
    const a = activeRenderWc()
    return a != null && a.id === id
  }

  // Render guests we've acquired a broker lease for (keyed wc.id) so a
  // re-resolve of the same guest doesn't double-subscribe.
  const guestLeases = new Map<number, CdpSessionLease>()

  const stop = (): void => {
    disposed = true
    if (reconcileTimer) { clearInterval(reconcileTimer); reconcileTimer = null }
    for (const lease of guestLeases.values()) {
      try { lease.dispose() } catch { /* already gone */ }
    }
    guestLeases.clear()
    // Only detach sessions we self-attached if we own the broker's lifecycle —
    // a shared/injected broker keeps serving other consumers past our stop().
    if (ownsBroker) broker.dispose()
    // Run the late-wired teardown once (render events, dom-ready, 'closed' sub).
    if (lateCleanup) { const c = lateCleanup; lateCleanup = null; try { c() } catch { /* already gone */ } }
  }

  // ── main → front-end dispatch (shared transport, see frontend-dispatch.js) ──

  // Reply to a front-end command id, passing the ORIGINAL id + sessionId
  // straight through (no mapping) — the same settled-gate + chunking +
  // reply-shape contract network-forward's global body gate uses, so the two
  // outbound-gate features can never drift.
  const { dispatchToFrontend, replyResult, replyError } = createFrontendReplyChannel(devtoolsWc, () => disposed)

  /** Tell the front-end its document is stale → it re-pulls lazily (routed). */
  function pushDocumentUpdated(): void {
    if (disposed || devtoolsWc.isDestroyed()) return
    // Same unified settled gate as dispatchToFrontend — render events (the
    // activePage burst) drive this during churn.
    if (!isFrontendSettled(devtoolsWc)) return
    let script: string
    try {
      script = buildDocumentUpdatedScript()
    } catch {
      return
    }
    devtoolsWc.executeJavaScript(script, true).catch(() => { /* booting/torn-down */ })
  }

  // ── render-guest CDP session (via the shared broker) ────────────────────────

  /** The active render guest, re-resolved fresh (pool/page swaps go stale). */
  function activeRenderWc(): WebContents | null {
    try {
      const wc = bridge.getActiveRenderWc(deps.appId)
      return wc && !wc.isDestroyed() ? wc : null
    } catch {
      return null
    }
  }

  /**
   * Get-or-create this guest's broker lease and wire our render-event
   * re-injection listener on it ONCE. DOM./CSS./Overlay./DOMSnapshot./
   * DOMDebugger. EVENTS (no id) from the CURRENT generation are dispatched
   * into the front-end so the Elements panel updates live; events arriving
   * after the generation moved on are dropped. `lease.onDetach` — which fires
   * on an external detach OR the guest being destroyed (see cdp-session's
   * design doc) — drops our cache entry so the NEXT call re-acquires fresh
   * instead of operating on a dead lease forever.
   */
  function ensureGuestLease(wc: WebContents): CdpSessionLease | null {
    const existing = guestLeases.get(wc.id)
    if (existing) return existing
    const lease = broker.acquire(wc)
    if (!lease) return null

    lease.onMessage((method, params) => {
      if (disposed) return
      // Honour events only while this guest is STILL the active one — checked
      // per event, so re-activating a previously-wired guest resumes forwarding.
      if (!isActiveWcId(wc.id)) return
      if (isRenderEventMethod(method)) {
        dispatchToFrontend({ method, params })
      }
    })
    lease.onDetach(() => {
      // A destroyed/detached guest is no longer the active one, so its
      // in-flight commands fail `isActiveWcId` and settle as errors on their
      // own — no global bump (which would wrongly stale OTHER, still-active
      // guests' commands).
      guestLeases.delete(wc.id)
    })

    guestLeases.set(wc.id, lease)
    return lease
  }

  /**
   * enable DOM/CSS/Overlay + wire events on a guest. Best-effort (never throws).
   *
   * `Overlay.enable` is sent ONLY AFTER `DOM.enable` has resolved: Chromium rejects
   * `Overlay.enable` with "DOM should be enabled first" when it arrives before the
   * DOM domain is enabled, and a silently-dropped rejection leaves Overlay disabled
   * so every later `Overlay.highlightNode` fails with "Overlay must be enabled" and
   * the Elements-panel hover highlight never paints. Awaiting DOM.enable first
   * guarantees the correct enable order. CSS.enable has no such dependency and is
   * fire-and-forget alongside.
   *
   * This does NOT delegate to `lease.ensureRenderDomains()`: that helper has no
   * concept of "active guest", but a priming sequence started on a guest that
   * stops being active mid-flight must NOT arm Overlay on the now-abandoned
   * tree (checked again below) — a per-consumer concern only elements-forward
   * has, so it keeps its own sequence, just dispatched through the lease.
   */
  function primeGuest(wc: WebContents): void {
    const lease = ensureGuestLease(wc)
    if (!lease) return
    void enableGuestDomains(wc, lease)
  }

  /** Enable the render domains in dependency order. Resolves; never rejects. */
  async function enableGuestDomains(wc: WebContents, lease: CdpSessionLease): Promise<void> {
    lease.send('CSS.enable').catch(() => { /* guest mid-destroy */ })
    try {
      await lease.send('DOM.enable')
    } catch {
      // Guest mid-destroy or DOM domain unavailable; Overlay.enable would only
      // re-reject, so stop here rather than firing it out of order.
      return
    }
    // DOM.enable can settle after the guest was destroyed or the active page
    // switched away (priming always targets the active guest). Re-check before
    // arming Overlay so a stale/dead guest is left untouched.
    if (disposed || !isActiveWcId(wc.id)) return
    lease.send('Overlay.enable').catch(() => { /* guest mid-destroy */ })
  }

  // ── front-end → render command routing ─────────────────────────────────────

  function routeCommand(cmd: OutboundCommand): void {
    const wc = activeRenderWc()
    if (!wc) {
      replyError(cmd, 'no active render guest')
      return
    }
    const lease = ensureGuestLease(wc)
    if (!lease) {
      replyError(cmd, 'render guest debugger unavailable')
      return
    }
    // The wc this command is dispatched to. A response that resolves after the
    // active guest changed (this wc is no longer active) is for a tree the
    // front-end has abandoned: settle the id with an error (no pending leak) but
    // do NOT feed its result into the new tree.
    const cmdWcId = wc.id
    lease
      .send(cmd.method, (cmd.params ?? {}) as object)
      .then((result: unknown) => {
        if (disposed) return
        if (!isActiveWcId(cmdWcId)) {
          replyError(cmd, 'stale render generation')
          return
        }
        // The front-end emits `Overlay.disable` on Elements-panel state
        // transitions. Forwarded verbatim it disables the guest's Overlay agent,
        // after which every `Overlay.highlightNode` fails with "Overlay must be
        // enabled" and the hover highlight stops painting. Re-arm it so the next
        // hover paints — only while this guest is still the active one.
        if (cmd.method === 'Overlay.disable' && isActiveWcId(cmdWcId)) {
          lease.send('Overlay.enable').catch(() => { /* guest gone */ })
        }
        replyResult(cmd, result)
      })
      .catch((err: unknown) => {
        if (disposed) return
        replyError(cmd, err instanceof Error ? err.message : String(err))
      })
  }

  /**
   * Answer a network-routed command from the provider. Never touches the render
   * guest: the body lives in the network forwarder's prefetch cache (or
   * nowhere). Shared with network-forward's dedicated global body gate — see
   * answerNetworkBodyCommand's doc comment for the not-found/reply contract.
   */
  function answerNetworkCommand(cmd: OutboundCommand): void {
    answerNetworkBodyCommand(cmd, deps.network, { replyResult, replyError })
  }

  /** Process a drained batch of front-end commands, splitting by route tag. */
  function handleOutbound(batch: unknown): void {
    drainOutboundBatch<OutboundCommand>(batch, (cmd) => {
      if (cmd.route === 'network') {
        answerNetworkCommand(cmd)
        return
      }
      // 'render' — and any untagged legacy payload, which only ever carried
      // render-domain commands.
      routeCommand(cmd)
    })
  }

  // ── follow the active guest across page switches ───────────────────────────

  const onRenderEvent = (event: RenderEvent): void => {
    if (disposed) return
    if (event.kind !== 'activePage') return
    // Active guest changed: late responses/events from the previous guest now
    // fail `isActiveWcId` and are discarded; the (re-)activated guest's traffic
    // is honoured again (no snapshot to strand it).
    const wc = activeRenderWc()
    if (!wc) return
    primeGuest(wc)
    // Front-end (which eager-pulls DOM at bootstrap) re-pulls against the now
    // current guest; if the user is already on Elements it refreshes live.
    pushDocumentUpdated()
  }
  const unsubscribeRenderEvents = bridge.onRenderEvent(onRenderEvent)

  // ── self-healing reconcile loop: (re)install hook + drain, every tick ───────

  const onReady = (): void => {
    if (disposed) return
    // Re-arm safe: a devtools front-end (re)load re-runs this, so clear any prior
    // loop before starting a fresh one — without this a reload would stack
    // intervals (leak) and double-drain.
    if (reconcileTimer) { clearInterval(reconcileTimer); reconcileTimer = null }

    // ONE loop, never self-terminating: each tick idempotently (re)installs the
    // hook AND drains the outbound queue in a single round-trip. The earlier
    // design stopped its install poll on first success and re-armed ONLY via
    // `dom-ready` — but a service-host pool swap on a hot-reload respawn re-points
    // the front-end without a reliable `dom-ready`, so the hook (which lives in
    // the front-end `globalThis` and is wiped on every reload) stayed uninstalled
    // and Elements fell back to the natively-inspected service host. Re-asserting
    // the hook every tick makes re-establishment independent of any single event.
    // The tick we freshly (re)wrap a reloaded front-end (`status === 'installed'`)
    // we re-prime the active guest and nudge a re-pull so the panel snaps back to
    // the render guest. We deliberately do NOT force showView('elements') — the
    // panel stays on the user-preferred Console default; the eager DOM pull (and
    // any later Elements click) is already routed to render.
    reconcileTimer = setInterval(() => {
      if (disposed || devtoolsWc.isDestroyed()) { stop(); return }
      // An unsettled front-end can't run the script anyway, and executeJavaScript
      // against it queues one did-stop-loading waiter PER TICK on the emitter
      // (150ms × a seconds-long reload piles past the MaxListeners ceiling).
      // MUST be the shared Electron-aligned predicate — a bare isLoading()
      // probe diverges from Electron's internal isLoadingMainFrame gate and
      // keeps piling. Skip; the first post-settle tick re-establishes the hook.
      if (!isFrontendSettled(devtoolsWc)) return
      devtoolsWc
        .executeJavaScript(buildReconcileScript())
        .then((res: unknown) => {
          if (disposed) return
          const r = (res ?? {}) as { status?: unknown, batch?: unknown }
          if (r.status === 'installed') {
            const wc = activeRenderWc()
            if (wc) primeGuest(wc)
            pushDocumentUpdated()
          }
          handleOutbound(r.batch)
        })
        .catch(() => { /* booting / navigating / torn-down — retried next tick */ })
    }, DRAIN_INTERVAL_MS)
  }

  // `dom-ready` re-arms the loop promptly on a front-end (re)load; the loop itself
  // is the durable self-healer (it re-asserts the hook every tick regardless), so
  // a missed `dom-ready` no longer leaves Elements stuck on the service host.
  devtoolsWc.on('dom-ready', onReady)
  onReady()
  let devtoolsClosedSub: { dispose(): void } | undefined
  try {
    // Devtools front-end wc is never pool-reset → use `'closed'` (fires only on
    // real destroy). `on('closed')` dispose() removes WITHOUT firing, so `stop()`
    // (which now disposes it) can be the sole teardown — no stale disposers
    // accumulate across re-install on a surviving devtoolsWc.
    if (deps.connections) devtoolsClosedSub = deps.connections.acquire(devtoolsWc).on('closed', stop)
    else devtoolsWc.once('destroyed', stop)
  } catch { /* fake/minimal wc */ }

  // Now that every subscription exists, route them through `stop()` so a teardown
  // from ANY entry point (returned disposer, 'closed'/'destroyed' handler, or the
  // reconcile tick noticing the wc is gone) does the identical full cleanup.
  lateCleanup = () => {
    try { unsubscribeRenderEvents() } catch { /* already gone */ }
    try { devtoolsClosedSub?.dispose() } catch { /* already gone */ }
    try { devtoolsWc.removeListener('dom-ready', onReady) } catch { /* already gone */ }
  }

  return stop
}
