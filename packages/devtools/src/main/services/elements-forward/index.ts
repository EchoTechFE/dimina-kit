/**
 * Elements-panel forwarding — reflect the ACTIVE RENDER GUEST's live DOM tree in
 * the right-panel Chrome DevTools front-end, which natively inspects the
 * service-host (logic layer).
 *
 * ── Mechanism (no preload, no broker) ────────────────────────────────────────
 * The DevTools front-end is a `devtools://` page with NO dimina preload, so we
 * drive it through the same two-way poll bridge the network-forward path uses:
 *   • front-end → main : we wrap `InspectorFrontendHost.sendMessageToBackend` in
 *     the front-end realm. Commands whose method is in the RENDER domain set
 *     (DOM/CSS/Overlay/DOMSnapshot/DOMDebugger) are NOT passed to the original
 *     embedder channel — they're pushed onto `globalThis.__diminaElementsOutbound`
 *     and main drains that array (splice) on a poll. EVERY OTHER method
 *     (Runtime/Console/Page/Target/Emulation/…) calls through to the original, so
 *     the service-host inspection (Console, Sources) and crucially the safe-area
 *     `Emulation.setSafeAreaInsetsOverride` are untouched.
 *   • main → front-end : we re-inject responses + render-side EVENTS via
 *     `window.DevToolsAPI.dispatchMessage(json)` (chunked for large payloads —
 *     `DOM.getDocument` can be big — mirroring network-forward/index.ts).
 *
 * ── Why no broker / no safe-area changes ─────────────────────────────────────
 * `webContents.debugger` is single-owner per wc, and the safe-area service has
 * already `attach('1.3')`-ed each render guest. We REUSE that already-attached
 * session (`sendCommand` + an extra `on('message')` listener on the SAME
 * `wc.debugger`); we never attach a second session and never detach one we don't
 * own. `DOM.enable`/`CSS.enable`/`Overlay.enable` do not reset the safe-area
 * `Emulation` override, so this is purely additive. ONLY when a guest's debugger
 * is NOT attached (safe-area degraded) do we `attach('1.3')` ourselves — tracked
 * in a `Set<wc.id>` so dispose/guest-destroy detaches ONLY the sessions we own;
 * safe-area's are never touched.
 *
 * ── Staleness (active-guest, NOT a generation counter) ───────────────────────
 * A response/event is honoured only while its originating guest is STILL the
 * active render guest — resolved fresh from the bridge per check (`isActiveWcId`),
 * not snapshotted. So a late response or stray render EVENT from a guest that is
 * no longer active is dropped (its in-flight command id is settled with an error
 * so the front-end never leaks a pending request, and stale nodes never bleed into
 * the new tree); and switching away and BACK to a previously-wired guest RESUMES
 * its forwarding (a snapshot would strand it — that was bug B2).
 *
 * ── Degradation ──────────────────────────────────────────────────────────────
 * Hook unavailable / `DevToolsAPI` missing / no active guest → routing is simply
 * inert; the Elements panel falls back to the front-end's native service-host
 * DOM (the prior behaviour). Everything is try/catch + feature-detect + bounded
 * polling: it never throws, never blocks, never disturbs Console/Network/safe-area.
 *
 * This is a production feature (no env gate, default on for the native simulator).
 * It deliberately re-implements the small pure helpers it needs (routing table,
 * hook + dispatch scripts) rather than importing the throwaway spike file.
 */
import { webContents as electronWebContents } from 'electron'
import type { WebContents } from 'electron'
import type { ConnectionRegistry } from '@dimina-kit/workbench/main'
import type { BridgeRouterHandle, RenderEvent } from '../../ipc/bridge-router.js'

// ── routing table (pure, testable) ───────────────────────────────────────────

/** Which target a front-end CDP command is routed to. */
export type CdpRoute = 'render' | 'service'

/**
 * CDP domains that target the RENDER GUEST'S document tree. A command in one of
 * these is intercepted and sent to the active render guest's debugger instead of
 * the service host the front-end nominally inspects.
 */
const RENDER_DOMAIN_PREFIXES: readonly string[] = [
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

// ── front-end injection (the front-end → main half of the bridge) ────────────

/**
 * The JS injected into the DevTools front-end realm. Idempotent (sentinel guard).
 * Wraps `InspectorFrontendHost.sendMessageToBackend`: a RENDER-domain command is
 * pushed onto `globalThis.__diminaElementsOutbound` (drained by main) and NOT
 * forwarded to the original embedder channel (main answers it from the render
 * guest); every other command calls through to the original (service-host path).
 *
 * Returns `'installed'` / `'already'` on success, `'partial'` while the embedder
 * global is not yet present (so the caller retries), `'error:…'` on a real fault.
 */
export function buildElementsHookScript(): string {
  const prefixes = JSON.stringify(RENDER_DOMAIN_PREFIXES)
  return `(function(){try{
    if (globalThis.__diminaElementsHookInstalled) return 'already';
    var OUT = (globalThis.__diminaElementsOutbound = globalThis.__diminaElementsOutbound || []);
    var PREFIXES = ${prefixes};
    function isRender(method){
      if (!method) return false;
      for (var i=0;i<PREFIXES.length;i++){ if (method.indexOf(PREFIXES[i])===0) return true; }
      return false;
    }
    var IFH = globalThis.InspectorFrontendHost;
    if (IFH && typeof IFH.sendMessageToBackend === 'function' && !IFH.__diminaElementsWrapped){
      var origSend = IFH.sendMessageToBackend.bind(IFH);
      IFH.sendMessageToBackend = function(message){
        try {
          var m = (typeof message === 'string') ? JSON.parse(message) : message;
          if (m && isRender(m.method)){
            // Intercept: hand it to main to route at the render guest. Do NOT
            // call the original embedder channel (would hit the service host).
            OUT.push({ id: (m && typeof m.id === 'number') ? m.id : null,
              method: m.method, params: m.params || {},
              sessionId: (m && m.sessionId) ? m.sessionId : null });
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

// ── main → front-end dispatch (mirrored from network-forward/index.ts) ────────
// network-forward keeps these file-private and the task forbids touching it, so
// they're re-implemented here. Keep the chunk contract in sync if that changes.

const PROBE_DEVTOOLS_API
  = `(window.DevToolsAPI && typeof window.DevToolsAPI.dispatchMessage === 'function')`

/** A single dispatch payload may not exceed this many UTF-16 chars; chunk above. */
const MAX_SINGLE_DISPATCH_CHARS = 1_000_000
const CHUNK_CHARS = 256 * 1024

/** Dispatch ONE small CDP message (response or event) into the front-end. */
function buildDispatchScript(message: string): string {
  return `(()=>{try{`
    + `if(!${PROBE_DEVTOOLS_API})return false;`
    + `window.DevToolsAPI.dispatchMessage(JSON.parse(${JSON.stringify(message)}));`
    + `return true;`
    + `}catch(_){return false}})()`
}

/**
 * Dispatch one LARGE message via `dispatchMessageChunk`: the FIRST chunk carries
 * the total size, every SUBSEQUENT chunk omits the second arg (Chromium's
 * continuation contract). Returns false when the chunk API isn't present yet.
 */
function buildChunkedDispatchScript(chunks: string[], totalSize: number): string {
  const arr = JSON.stringify(chunks)
  return `(()=>{try{`
    + `if(!(window.DevToolsAPI&&typeof window.DevToolsAPI.dispatchMessageChunk==='function'))return false;`
    + `const cs=JSON.parse(${JSON.stringify(arr)});`
    + `for(let i=0;i<cs.length;i++){`
    + `try{`
    + `if(i===0){window.DevToolsAPI.dispatchMessageChunk(cs[i], ${totalSize})}`
    + `else{window.DevToolsAPI.dispatchMessageChunk(cs[i])}`
    + `}catch(_){}`
    + `}`
    + `return true;`
    + `}catch(_){return false}})()`
}

/** Script that nudges the front-end to discard its document and lazily re-pull. */
function buildDocumentUpdatedScript(): string {
  const msg = JSON.stringify({ method: 'DOM.documentUpdated', params: {} })
  return buildDispatchScript(msg)
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
   * Optional connection registry. When present, per-webContents teardowns
   * (the devtools front-end wc's `stop`, and each render guest's `onDestroyed`)
   * are routed through `connections.acquire(wc).own(cleanup)` so they fire
   * deterministically on wc destroy / connection reset — replacing the bespoke
   * `wc.once('destroyed', cleanup)` hook. Optional so existing callers compile
   * unchanged; absent → the `once('destroyed')` fallback is used.
   */
  connections?: ConnectionRegistry
}

/** One drained front-end command awaiting routing at the render guest. */
interface OutboundCommand {
  id: number | null
  method: string
  params: unknown
  sessionId: string | null
}

const DRAIN_INTERVAL_MS = 150
/** Bounded retry for the front-end hook install (front-end boots asynchronously). */
const INSTALL_POLL_TRIES = 80
const INSTALL_POLL_INTERVAL_MS = 50

/**
 * Install Elements forwarding on a DevTools front-end host wc. Returns a disposer
 * (`stop`) that clears timers, unsubscribes render events, detaches ONLY the
 * debugger sessions this feature attached, and removes every listener it added.
 *
 * Best-effort + defensive throughout: a destroyed wc ends the feature; every
 * executeJavaScript / sendCommand is wrapped so a torn-down guest never throws
 * and an in-flight command always settles (we dispatch an error back rather than
 * leaving the front-end pending).
 */
export function installElementsForward(deps: ElementsForwardDeps): () => void {
  const { devtoolsWc, bridge } = deps
  let disposed = false
  let installTimer: ReturnType<typeof setInterval> | null = null
  let drainTimer: ReturnType<typeof setInterval> | null = null

  // Staleness is keyed on the CURRENT active render guest, resolved fresh from the
  // bridge per check — NOT a generation snapshot. An event/response is honoured
  // only while its originating guest is still the active one, so switching away
  // and BACK to a previously-wired guest RESUMES its forwarding (a snapshot would
  // strand it forever — that was bug B2). It also means destroying some OTHER
  // (non-active) guest never stales the active guest's in-flight commands.
  const isActiveWcId = (id: number): boolean => {
    const a = activeRenderWc()
    return a != null && a.id === id
  }

  // Render guests we've added our `on('message')` listener to (keyed wc.id →
  // cleanup) so a re-resolve of the same guest doesn't double-subscribe.
  const wiredGuests = new Map<number, () => void>()

  // Debugger sessions THIS feature attached (safe-area was degraded). dispose /
  // guest-destroy detaches ONLY these; sessions safe-area owns are never touched.
  const selfAttached = new Set<number>()

  const stop = (): void => {
    disposed = true
    if (installTimer) { clearInterval(installTimer); installTimer = null }
    if (drainTimer) { clearInterval(drainTimer); drainTimer = null }
    for (const cleanup of wiredGuests.values()) {
      try { cleanup() } catch { /* guest gone */ }
    }
    wiredGuests.clear()
    detachSelfAttached()
  }

  /** Detach every session we own; leave safe-area's alone. */
  function detachSelfAttached(): void {
    for (const wcId of selfAttached) {
      const wc = wcFromId(wcId)
      if (!wc) continue
      try {
        if (!wc.isDestroyed() && wc.debugger.isAttached()) wc.debugger.detach()
      } catch { /* already detached / destroyed */ }
    }
    selfAttached.clear()
  }

  // ── main → front-end dispatch ──────────────────────────────────────────────

  function dispatchToFrontend(message: unknown): void {
    if (disposed || devtoolsWc.isDestroyed()) return
    let json: string
    try {
      json = JSON.stringify(message)
    } catch {
      return
    }
    if (json.length > MAX_SINGLE_DISPATCH_CHARS) {
      const chunks: string[] = []
      for (let i = 0; i < json.length; i += CHUNK_CHARS) {
        chunks.push(json.slice(i, i + CHUNK_CHARS))
      }
      let script: string
      try {
        script = buildChunkedDispatchScript(chunks, json.length)
      } catch {
        return
      }
      devtoolsWc.executeJavaScript(script, true).catch(() => { /* booting/torn-down */ })
      return
    }
    let script: string
    try {
      script = buildDispatchScript(json)
    } catch {
      return
    }
    devtoolsWc.executeJavaScript(script, true).catch(() => { /* booting/torn-down */ })
  }

  /** Tell the front-end its document is stale → it re-pulls lazily (routed). */
  function pushDocumentUpdated(): void {
    if (disposed || devtoolsWc.isDestroyed()) return
    let script: string
    try {
      script = buildDocumentUpdatedScript()
    } catch {
      return
    }
    devtoolsWc.executeJavaScript(script, true).catch(() => { /* booting/torn-down */ })
  }

  /**
   * Reply to a front-end command id, passing the ORIGINAL id + sessionId straight
   * through (no mapping). Only the front-end-supplied sessionId is echoed back.
   */
  function replyResult(cmd: OutboundCommand, result: unknown): void {
    const msg: Record<string, unknown> = { id: cmd.id, result }
    if (cmd.sessionId) msg.sessionId = cmd.sessionId
    dispatchToFrontend(msg)
  }
  function replyError(cmd: OutboundCommand, message: string): void {
    const msg: Record<string, unknown> = { id: cmd.id, error: { code: -32000, message } }
    if (cmd.sessionId) msg.sessionId = cmd.sessionId
    dispatchToFrontend(msg)
  }

  // ── webContents lookup (id → wc), tolerant of fakes/teardown ────────────────

  function wcFromId(id: number): WebContents | null {
    try {
      return electronWebContents?.fromId?.(id) ?? null
    } catch {
      return null
    }
  }

  // ── render-guest CDP session (reuse safe-area's; self-attach only if needed) ─

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
   * Ensure the guest's debugger is usable. Reuse the already-attached session if
   * safe-area attached it; only `attach('1.3')` ourselves when nobody has — and
   * record that wc in `selfAttached` so we (and only we) detach it later. Returns
   * false when the debugger can't be made usable.
   */
  function ensureGuestDebugger(wc: WebContents): boolean {
    try {
      if (wc.debugger.isAttached()) return true
    } catch {
      return false
    }
    try {
      wc.debugger.attach('1.3')
      selfAttached.add(wc.id)
      return true
    } catch {
      // Either someone else just attached (race → it IS usable) or attach truly
      // failed. Treat "already attached" as success, anything else as failure.
      try { return wc.debugger.isAttached() } catch { return false }
    }
  }

  /**
   * Add our render-event re-injection listener to a guest's debugger ONCE. DOM./
   * CSS./Overlay./DOMSnapshot./DOMDebugger. EVENTS (no id) from the CURRENT
   * generation are dispatched into the front-end so the Elements panel updates
   * live; events arriving after the generation moved on are dropped. The listener
   * is removed when the guest wc is destroyed (and on stop()).
   */
  function wireGuestEvents(wc: WebContents): void {
    if (wiredGuests.has(wc.id)) return
    const onMessage = (_event: Electron.Event, method: string, params: unknown): void => {
      if (disposed) return
      // Honour events only while this guest is STILL the active one — checked per
      // event, so re-activating a previously-wired guest resumes forwarding.
      if (!isActiveWcId(wc.id)) return
      if (isRenderEventMethod(method)) {
        dispatchToFrontend({ method, params })
      }
    }
    try {
      wc.debugger.on('message', onMessage)
    } catch {
      return
    }
    const onDestroyed = (): void => {
      const cleanup = wiredGuests.get(wc.id)
      if (cleanup) { wiredGuests.delete(wc.id); try { cleanup() } catch { /* gone */ } }
      // A destroyed guest is no longer the active one, so its in-flight commands
      // fail `isActiveWcId` and settle as errors on their own — no global bump
      // (which would wrongly stale OTHER, still-active guests' commands: bug MINOR-3).
      // If we own this wc's session there is nothing left to detach; drop it.
      selfAttached.delete(wc.id)
    }
    let closedSub: { dispose(): void } | undefined
    try {
      // Route the guest teardown through the connection registry's `'closed'`
      // event when present. Render guests are NEVER pool-reset, so `'closed'`
      // (fires only on real wc destroy) is the correct lifetime — and crucially
      // `on('closed')` returns a handle whose `dispose()` REMOVES the listener
      // WITHOUT firing it, matching the original `removeListener` semantics.
      // (`own()` would fire `onDestroyed` on release AND mutate `wiredGuests`
      // mid-drain in stop() — wrong here; see foundation.md §4.3.) Same
      // try/catch guards a fake/minimal wc that lacks once/emitter wiring.
      if (deps.connections) closedSub = deps.connections.acquire(wc).on('closed', onDestroyed)
      else wc.once('destroyed', onDestroyed)
    } catch { /* fake/minimal wc */ }
    wiredGuests.set(wc.id, () => {
      try { wc.debugger.removeListener('message', onMessage) } catch { /* gone */ }
      try { closedSub?.dispose() } catch { /* gone */ }
      try { wc.removeListener('destroyed', onDestroyed) } catch { /* gone */ }
    })
  }

  /** enable DOM/CSS/Overlay + wire events on a guest. Best-effort. */
  function primeGuest(wc: WebContents): void {
    if (!ensureGuestDebugger(wc)) return
    wireGuestEvents(wc)
    for (const domain of ['DOM.enable', 'CSS.enable', 'Overlay.enable']) {
      wc.debugger.sendCommand(domain).catch(() => { /* guest mid-destroy */ })
    }
  }

  // ── front-end → render command routing ─────────────────────────────────────

  function routeCommand(cmd: OutboundCommand): void {
    const wc = activeRenderWc()
    if (!wc) {
      replyError(cmd, 'no active render guest')
      return
    }
    if (!ensureGuestDebugger(wc)) {
      replyError(cmd, 'render guest debugger unavailable')
      return
    }
    wireGuestEvents(wc)
    // The wc this command is dispatched to. A response that resolves after the
    // active guest changed (this wc is no longer active) is for a tree the
    // front-end has abandoned: settle the id with an error (no pending leak) but
    // do NOT feed its result into the new tree.
    const cmdWcId = wc.id
    wc.debugger
      .sendCommand(cmd.method, (cmd.params ?? {}) as object)
      .then((result: unknown) => {
        if (disposed) return
        if (!isActiveWcId(cmdWcId)) {
          replyError(cmd, 'stale render generation')
          return
        }
        replyResult(cmd, result)
      })
      .catch((err: unknown) => {
        if (disposed) return
        replyError(cmd, err instanceof Error ? err.message : String(err))
      })
  }

  /** Process a drained batch of front-end commands. */
  function handleOutbound(batch: unknown): void {
    if (!Array.isArray(batch)) return
    for (const raw of batch) {
      if (!raw || typeof raw !== 'object') continue
      const cmd = raw as OutboundCommand
      if (typeof cmd.method !== 'string') continue
      routeCommand(cmd)
    }
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

  // ── startup: install hook (retry until embedder exists), then drain ─────────

  const onReady = (): void => {
    if (disposed) return
    let tries = 0
    installTimer = setInterval(() => {
      tries++
      if (disposed || devtoolsWc.isDestroyed()) { stop(); return }
      devtoolsWc
        .executeJavaScript(buildElementsHookScript())
        .then((status: unknown) => {
          if (disposed) return
          if (status === 'installed' || status === 'already') {
            if (installTimer) { clearInterval(installTimer); installTimer = null }
            // Prime the current guest, then nudge the front-end to (re-)pull DOM
            // so the bootstrap document.getDocument is routed at the render guest.
            // We deliberately do NOT force showView('elements') — the panel stays
            // on the user-preferred Console default; the eager DOM pull (and any
            // later Elements click) is already routed to render.
            const wc = activeRenderWc()
            if (wc) primeGuest(wc)
            pushDocumentUpdated()
          }
        })
        .catch(() => { /* booting / torn-down */ })
      if (tries > INSTALL_POLL_TRIES && installTimer) { clearInterval(installTimer); installTimer = null }
    }, INSTALL_POLL_INTERVAL_MS)

    // Poll-drain the outbound command queue.
    drainTimer = setInterval(() => {
      if (disposed || devtoolsWc.isDestroyed()) { stop(); return }
      devtoolsWc
        .executeJavaScript('(globalThis.__diminaElementsOutbound ? __diminaElementsOutbound.splice(0) : [])')
        .then(handleOutbound)
        .catch(() => { /* destroyed / navigating */ })
    }, DRAIN_INTERVAL_MS)
  }

  if (devtoolsWc.isLoading()) {
    devtoolsWc.once('dom-ready', onReady)
  } else {
    onReady()
  }
  let devtoolsClosedSub: { dispose(): void } | undefined
  try {
    // Devtools front-end wc is never pool-reset → use `'closed'` (fires only on
    // real destroy). `on('closed')` dispose() removes WITHOUT firing, so the
    // returned teardown releases it then calls `stop()` directly — no stale
    // `stop` disposers accumulate across re-install on a surviving devtoolsWc.
    if (deps.connections) devtoolsClosedSub = deps.connections.acquire(devtoolsWc).on('closed', stop)
    else devtoolsWc.once('destroyed', stop)
  } catch { /* fake/minimal wc */ }

  return () => {
    try { unsubscribeRenderEvents() } catch { /* already gone */ }
    try { devtoolsClosedSub?.dispose() } catch { /* already gone */ }
    stop()
  }
}
