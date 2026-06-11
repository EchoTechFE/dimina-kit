/**
 * Native-host network forwarder.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * The right-panel "Network" view is the embedded Chrome DevTools front-end. In
 * native-host that front-end is attached to the SERVICE HOST webContents (see
 * view-manager `pointNativeDevtoolsAtServiceWc`), so its Network tab only ever
 * shows the service host's own network activity.
 *
 * But the mini-app's `wx.request` / `dd.request` / `downloadFile` / `uploadFile`
 * do NOT run in the service host. bridge-router forwards every `invokeAPI` that
 * isn't registered host-side to the SIMULATOR WebContentsView via `E.API_CALL`,
 * and DeviceShell runs the handler there (`device-shell.tsx` → `runApiAsync` →
 * `direct-request.ts`/`simulator-api-network.ts`, which call `fetch()` /
 * `XMLHttpRequest`). Those requests therefore go through the simulator WCV's
 * network stack — a DIFFERENT webContents than the one the DevTools front-end
 * inspects — so they were invisible in the Network panel after the native-host
 * refactor. THAT is the regression this service closes.
 *
 * ── How it surfaces them (primary sink: native Network tab) ─────────────────
 * We attach the CDP `webContents.debugger` to the simulator WCV, `Network.enable`,
 * and listen for the Network.* lifecycle events. Rather than reformat them, we
 * forward the RAW CDP messages straight into the WebContents that HOSTS the
 * DevTools front-end (the right-panel `simulatorView.webContents`), via
 * `window.DevToolsAPI.dispatchMessage(json)`. The bundled Chrome DevTools then
 * renders them natively in its own Network tab — same protocol path it would
 * use for its own inspected target.
 *
 * Because the front-end is inspecting the service host (a DIFFERENT target than
 * the simulator the events came from), the simulator's `requestId`s could
 * collide with the service host's own. We therefore rewrite every requestId
 * into a namespaced virtual id (`dimina:sim:<epoch>:<rawId>`) before dispatch,
 * keeping a raw→virtual map so redirects / extra-info / completion events on the
 * same request stay correlated. We inject on the MAIN session (no `sessionId`),
 * i.e. the events appear as activity on the currently-inspected target. This is
 * the one-shot approach the Codex review settled on; child-target routing
 * (`Target.attachedToTarget` + hooking outbound CDP) is explicitly deferred.
 *
 * ── Fallback sink (console line) ────────────────────────────────────────────
 * If the DevTools host wc is unavailable, or `window.DevToolsAPI.dispatchMessage`
 * never appears (front-end not bootstrapped), or a dispatch throws, we degrade
 * to the legacy behaviour: re-emit each COMPLETED request as one `[网络]`-prefixed
 * line into the SERVICE HOST's own console (where the DevTools is attached). That
 * keeps the requests visible in the panel the user already watches even when the
 * protocol path can't be used. The fallback never duplicates the native path —
 * it is chosen per completed-request, only when the native dispatch is known
 * unusable.
 *
 * ── Coverage (one-shot scope) ───────────────────────────────────────────────
 *  ✅ Forwarded to the native Network tab: requestWillBeSent, responseReceived,
 *     loadingFinished, loadingFailed (+ requestWillBeSentExtraInfo /
 *     responseReceivedExtraInfo when present, for accurate headers/status).
 *  ⏳ TODO (二期): `dataReceived` per-chunk forwarding (skipped to avoid an
 *     executeJavaScript per chunk), and response body / preview (needs hooking
 *     `InspectorFrontendHost.sendMessageToBackend` + a prefetched body cache so
 *     the front-end's `Network.getResponseBody` round-trip resolves).
 *  ⚠️ NOT captured here: requests issued from inside a render-host `<webview>`
 *     guest (page-level resource loads / page `fetch`). The safe-area service
 *     already owns each guest's `wc.debugger`, and `debugger.attach` is
 *     single-owner — bringing those in needs a shared CDP broker. `source:'render'`
 *     is reserved for when that's added (later).
 *  ⚠️ NOT observable by any `webContents.debugger`: a request a host module issues
 *     directly from the MAIN process. Those need an explicit `report()` call
 *     (exposed below; it uses the console fallback path).
 */
import type { WebContents } from 'electron'
import { DisposableRegistry, toDisposable, type ConnectionRegistry, type Disposable } from '@dimina-kit/electron-deck/main'

/** Which layer a captured request came from (tags the fallback log line). */
export type NetworkSource = 'service' | 'render'

/** A normalized completed network request, used only by the console fallback. */
export interface NetworkRequestRecord {
  source: NetworkSource
  url: string
  method: string
  /** HTTP status, or 0 when the request failed before a response. */
  status: number
  /** Failure text for `loadingFailed`, else undefined. */
  errorText?: string
}

/**
 * Resolvers the forwarder consults each time it needs a target wc. Both are
 * re-read on every use so a pre-warm-pool swap (service) or a DevTools-host
 * re-create (devtools) is tolerated without re-wiring.
 */
export interface NetworkForwarderBridge {
  /** The SERVICE HOST wc — fallback console sink target. */
  getServiceWc(appId?: string): WebContents | null
  /**
   * The wc hosting the right-panel Chrome DevTools FRONT-END (the one we inject
   * `window.DevToolsAPI.dispatchMessage` into). Set by the ViewManager via
   * `setDevtoolsHost`. Null until the DevTools host view exists.
   */
  getDevtoolsWc?(): WebContents | null
  /**
   * Optional connection-layer registry (`@dimina-kit/electron-deck/main`). When
   * present, per-webContents teardowns route through `acquire(wc).own(d)` so the
   * Connection disposes them deterministically on wc destroy / reset (replacing
   * the bespoke `wc.once('destroyed', cleanup)`). Omitted → the legacy
   * `once('destroyed')` fallback is used, so existing callers compile unchanged.
   */
  connections?: ConnectionRegistry
}

export interface NetworkForwarder extends Disposable {
  /**
   * Attach the CDP debugger to the simulator WCV and start forwarding its
   * Network events. Idempotent for the same wc; re-pointing to a new wc (a
   * relaunch / pool swap) detaches the previous one first. No-op if the wc is
   * destroyed or its debugger is already claimed (DevTools / another client).
   */
  attachSimulator(wc: WebContents): void
  /** Detach from the current simulator WCV (without disposing the forwarder). */
  detachSimulator(): void
  /**
   * Point the forwarder at the WebContents hosting the DevTools FRONT-END (the
   * primary, native-Network-tab sink). Pass null when that view is torn down so
   * we fall back to the console line. Re-callable across DevTools re-creates.
   */
  setDevtoolsHost(wc: WebContents | null): void
  /**
   * Manually surface a request that no `webContents.debugger` can observe
   * (e.g. a main-process direct send). Uses the console fallback sink.
   */
  report(record: NetworkRequestRecord): void
}

// ── requestId namespacing (pure, testable) ──────────────────────────────────

/**
 * CDP events whose `params.requestId` we rewrite into the virtual namespace.
 * Anything carrying a requestId must be namespaced consistently — even methods
 * we don't (yet) forward — so the raw→virtual map stays coherent if forwarding
 * is widened later. `requestServedFromCache` and `resourceChangedPriority` are
 * included for that reason (MINOR: rewrite-only today, not forwarded).
 */
export const REWRITE_REQUEST_ID_METHODS: ReadonlySet<string> = new Set([
  'Network.requestWillBeSent',
  'Network.requestWillBeSentExtraInfo',
  'Network.responseReceived',
  'Network.responseReceivedExtraInfo',
  'Network.dataReceived',
  'Network.loadingFinished',
  'Network.loadingFailed',
  'Network.requestServedFromCache',
  'Network.resourceChangedPriority',
  // 二期 (when WebSocket/EventSource forwarding lands): Network.webSocket*,
  // Network.eventSourceMessageReceived — keep ids namespaced once added here.
])

/** The Network.* methods this one-shot pass forwards to the front-end. */
export const FORWARDED_METHODS: ReadonlySet<string> = new Set([
  'Network.requestWillBeSent',
  'Network.requestWillBeSentExtraInfo',
  'Network.responseReceived',
  'Network.responseReceivedExtraInfo',
  'Network.loadingFinished',
  'Network.loadingFailed',
  // `dataReceived` deliberately omitted (二期) — see header.
])

/** Methods that mark a request finished, so its id mapping can age out. */
const TERMINAL_METHODS: ReadonlySet<string> = new Set([
  'Network.loadingFinished',
  'Network.loadingFailed',
])

/**
 * Bounded, TTL'd raw→virtual requestId map with an active/retired split.
 *
 * An ACTIVE request (seen `requestWillBeSent`/ExtraInfo, not yet terminal) must
 * NEVER lose its mapping — otherwise a later `responseReceived`/`loadingFinished`
 * would mint a fresh virtual id and the front-end would see an orphaned event.
 * So active entries are exempt from both TTL and the LRU cap.
 *
 * Only once a request goes terminal (`loadingFinished`/`loadingFailed`) is it
 * RETIRED: its mapping is kept a while longer so genuinely-late events (an
 * extra-info after completion) still correlate, but it now ages out by TTL and
 * by an LRU cap so a long session never grows unbounded. Eviction only ever
 * touches the retired pool.
 */
export class RequestIdNamespace {
  private readonly map = new Map<string, { virtual: string; expires: number; active: boolean }>()
  private seq = 0

  constructor(
    private readonly epoch: string,
    private readonly ttlMs = 5 * 60_000,
    private readonly max = 1000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Resolve (lazily creating) the virtual id for a raw id. Lazy creation lets an
   * ExtraInfo event that arrives BEFORE its `requestWillBeSent` still get a
   * stable id that the later events reuse — a redirect chain reuses the same raw
   * id and therefore the same virtual id (we never mint a new one per redirect).
   *
   * A freshly-resolved (or any non-retired) entry is ACTIVE and thus immune to
   * eviction. We only TTL-expire entries that have already been retired; an
   * active entry never "expires" no matter how long it stays in flight.
   */
  resolve(rawId: string): string {
    const t = this.now()
    const existing = this.map.get(rawId)
    if (existing && (existing.active || existing.expires > t)) {
      // Refresh recency (LRU) on touch; refresh TTL only for retired entries
      // (active entries don't use TTL at all).
      if (!existing.active) existing.expires = t + this.ttlMs
      this.map.delete(rawId)
      this.map.set(rawId, existing)
      return existing.virtual
    }
    const virtual = `dimina:sim:${this.epoch}:${this.seq++}:${rawId}`
    this.map.set(rawId, { virtual, expires: t + this.ttlMs, active: true })
    this.evict(t)
    return virtual
  }

  /**
   * Mark a request terminal: it leaves the active set and enters the retired
   * pool with a fresh TTL, where it becomes eligible for TTL/LRU eviction.
   */
  retire(rawId: string): void {
    const e = this.map.get(rawId)
    if (e) {
      e.active = false
      e.expires = this.now() + this.ttlMs
    }
  }

  private evict(t: number): void {
    // Drop expired retired entries first (active entries never expire).
    for (const [k, v] of this.map) {
      if (!v.active && v.expires <= t) this.map.delete(k)
    }
    // Then LRU-trim the RETIRED pool to the cap. Active entries are exempt:
    // we walk in insertion/refresh order and skip any still-active entry, so an
    // in-flight request is never evicted even past the cap.
    if (this.map.size <= this.max) return
    for (const [k, v] of this.map) {
      if (this.map.size <= this.max) break
      if (!v.active) this.map.delete(k)
    }
  }

  /** Total entries (active + retired). */
  get size(): number {
    return this.map.size
  }

  /** Entries still in flight (resolved, not yet retired). */
  get activeSize(): number {
    let n = 0
    for (const v of this.map.values()) if (v.active) n++
    return n
  }
}

/**
 * Rewrite a single CDP message's `requestId` into the namespace, returning a new
 * `{ method, params }` (never mutating the input). Returns the message unchanged
 * when the method carries no requestId we track or params is malformed. Pure
 * aside from the namespace map it threads through.
 */
export function rewriteRequestId(
  method: string,
  params: unknown,
  ns: RequestIdNamespace,
): { method: string; params: unknown } {
  if (!REWRITE_REQUEST_ID_METHODS.has(method)) return { method, params }
  const p = params as { requestId?: unknown } | null | undefined
  if (!p || typeof p.requestId !== 'string') return { method, params }
  const virtual = ns.resolve(p.requestId)
  if (TERMINAL_METHODS.has(method)) ns.retire(p.requestId)
  return { method, params: { ...(p as object), requestId: virtual } }
}

// ── DevTools front-end injection (the primary sink) ─────────────────────────

/** Probe the front-end realm exposes `DevToolsAPI.dispatchMessage`. */
const PROBE_DEVTOOLS_API
  = `(window.DevToolsAPI && typeof window.DevToolsAPI.dispatchMessage === 'function')`

/**
 * Build the `executeJavaScript` source that dispatches a BATCH of raw CDP
 * messages into the DevTools front-end. Each message is carried as a JSON
 * literal (data, never interpolated code — same discipline as console-forward)
 * and dispatched via `DevToolsAPI.dispatchMessage`. Returns false out of the IIFE
 * when the API isn't there yet, so the main side knows to retry / fall back.
 */
function buildDispatchScript(messages: string[]): string {
  const arr = JSON.stringify(messages)
  return `(()=>{try{`
    + `if(!${PROBE_DEVTOOLS_API})return false;`
    + `const ms=JSON.parse(${JSON.stringify(arr)});`
    + `for(const m of ms){try{window.DevToolsAPI.dispatchMessage(m)}catch(_){}}`
    + `return true;`
    + `}catch(_){return false}})()`
}

/**
 * Build the `executeJavaScript` source for a chunked dispatch of one large CDP
 * message — DevTools' own transport caps a single `dispatchMessage` payload, so
 * the front-end exposes `dispatchMessageChunk(messageChunk, messageSize)` where
 * the FIRST chunk carries the total size and EVERY SUBSEQUENT chunk is called
 * with the chunk ONLY (second arg omitted). This matches Chromium's
 * `devtools_ui_bindings.cc` DispatchProtocolMessage, whose front-end treats a
 * call with a second argument as the start of a new message and a call without
 * one as a continuation. Passing 0 (the previous behaviour) risked the
 * front-end mis-reading a continuation as a fresh 0-size message. Returns false
 * when the API isn't available.
 */
function buildChunkedDispatchScript(chunks: string[], totalSize: number): string {
  const arr = JSON.stringify(chunks)
  return `(()=>{try{`
    + `if(!(window.DevToolsAPI&&typeof window.DevToolsAPI.dispatchMessageChunk==='function'))return false;`
    + `const cs=JSON.parse(${JSON.stringify(arr)});`
    + `for(let i=0;i<cs.length;i++){`
    + `try{`
    // First chunk: (chunk, totalSize). Subsequent chunks: (chunk) — second arg
    // omitted, NOT 0, per Chromium's continuation contract.
    + `if(i===0){window.DevToolsAPI.dispatchMessageChunk(cs[i], ${totalSize})}`
    + `else{window.DevToolsAPI.dispatchMessageChunk(cs[i])}`
    + `}catch(_){}`
    + `}`
    + `return true;`
    + `}catch(_){return false}})()`
}

/** A single dispatch payload may not exceed this many UTF-16 chars; chunk above. */
const MAX_SINGLE_DISPATCH_CHARS = 1_000_000
const CHUNK_CHARS = 256 * 1024

/**
 * Upper bound on the COMBINED size (in UTF-16 chars) of the messages packed into
 * one `executeJavaScript` batch. 2000 small messages otherwise stitch into a
 * single script that can blow past the IPC / script-size limit and reject the
 * whole batch. We pack greedily up to this many chars, then flush and start a
 * new batch, so each `executeJavaScript` stays well-sized.
 */
const MAX_BATCH_CHARS = 512 * 1024

// ── console fallback sink ───────────────────────────────────────────────────

/**
 * Build the `executeJavaScript` source that logs one request line into the
 * service host. Carried as a JSON literal and re-parsed service-side — no
 * captured value is ever interpolated into executable JS (data-not-code).
 */
function buildForwardScript(record: NetworkRequestRecord): string {
  const json = JSON.stringify(record)
  return `(()=>{try{const r=JSON.parse(${JSON.stringify(json)});`
    + `const tag='[网络]['+r.source+']';`
    + `const head=r.method+' '+(r.status||'-')+' '+r.url;`
    + `if(r.errorText){console.warn(tag,head,r.errorText)}`
    + `else if(r.status>=400){console.warn(tag,head)}`
    + `else{console.log(tag,head)}`
    + `}catch(_){}})()`
}

/** CDP `Network.requestWillBeSent` params slice the fallback reads. */
interface RequestWillBeSent {
  requestId: string
  request: { url: string; method: string }
}
/** CDP `Network.responseReceived` params slice the fallback reads. */
interface ResponseReceived {
  requestId: string
  response: { status: number }
}
/** CDP `Network.loadingFailed` params slice the fallback reads. */
interface LoadingFailed {
  requestId: string
  errorText?: string
  canceled?: boolean
}

/** Pending-request bookkeeping for the console fallback between events. */
interface Pending {
  url: string
  method: string
  status: number
}

/** Cap so a long session can't grow the fallback pending map unboundedly. */
const MAX_PENDING = 1000

/** Cap on the native dispatch queue (chars-agnostic count) while no/ready host. */
const MAX_DISPATCH_QUEUE = 2000
/**
 * How long we wait for `window.DevToolsAPI.dispatchMessage` to answer ready once
 * a host wc IS set, before giving up on the native path for that host and
 * degrading to the console sink. Prevents the infinite-requeue-never-fallback
 * loop when a host exists but its front-end never finishes booting.
 */
const DEVTOOLS_READY_TIMEOUT_MS = 5_000
/** Poll interval while probing for the front-end API to become ready. */
const READY_RETRY_MS = 100

/**
 * Per-host native-sink state. The forwarder routes EACH request to exactly one
 * sink, decided by this state, so a request can never appear in both Network and
 * console:
 *  - 'idle'     : no host wc configured. Completed requests go to console now;
 *                 the native queue is not accumulated (nothing will ever flush it).
 *  - 'probing'  : a host wc is set but its DevToolsAPI hasn't answered ready yet.
 *                 We buffer native events AND buffer completed-request records,
 *                 but emit NEITHER sink yet — we don't know which one wins. On
 *                 ready→'ready' (native wins, drop buffered console records); on
 *                 timeout→'degraded' (console wins, drop native queue).
 *  - 'ready'    : DevToolsAPI answered true. Native path renders; console suppressed.
 *  - 'degraded' : ready timed out for this host. Native path abandoned (queue
 *                 dropped, marked so the hot path stops retrying); console used.
 */
type SinkState = 'idle' | 'probing' | 'ready' | 'degraded'

export function createNetworkForwarder(bridge: NetworkForwarderBridge): NetworkForwarder {
  const registry = new DisposableRegistry()

  // The simulator WCV we currently have a debugger session on, and the
  // per-attach teardown (debugger listeners + detach). Null when not attached.
  let simWc: WebContents | null = null
  let attachDisposables: DisposableRegistry | null = null

  // The DevTools front-end host wc (primary sink), set by the ViewManager.
  let devtoolsWc: WebContents | null = null
  // Teardown for the wc 'destroyed' watcher on the current host (clears the host
  // here, in this file — view-manager is owned by another change and untouched).
  let devtoolsHostDisposable: Disposable | null = null

  // ── Native-sink state machine (MAJOR 1) ───────────────────────────────────
  let sink: SinkState = 'idle'
  // Buffered completed-request records while 'probing' — flushed to console if we
  // degrade, dropped if we go ready (so a request shows in exactly one sink).
  let probeConsoleBuffer: NetworkRequestRecord[] = []
  let readyTimeoutTimer: ReturnType<typeof setTimeout> | null = null

  // ── Batched native dispatch into the DevTools front-end ───────────────────
  // Queued raw CDP messages (already namespaced + JSON-stringified) awaiting a
  // microtask flush — coalescing many events into one executeJavaScript avoids
  // high-frequency IPC.
  let dispatchQueue: string[] = []
  let flushScheduled = false
  let readyRetryTimer: ReturnType<typeof setTimeout> | null = null

  function resolveDevtoolsWc(): WebContents | null {
    const wc = devtoolsWc ?? bridge.getDevtoolsWc?.() ?? null
    return wc && !wc.isDestroyed() ? wc : null
  }

  /** Enter the 'probing' state and arm the ready-timeout (idempotent). */
  function beginProbing(): void {
    if (sink === 'probing') return
    sink = 'probing'
    if (readyTimeoutTimer) clearTimeout(readyTimeoutTimer)
    readyTimeoutTimer = setTimeout(() => {
      readyTimeoutTimer = null
      // Still not ready after the grace period → abandon native for this host.
      if (sink === 'probing') degradeToConsole()
    }, DEVTOOLS_READY_TIMEOUT_MS)
  }

  /** Native path confirmed live: console buffer is moot, drop it. */
  function markReady(): void {
    sink = 'ready'
    if (readyTimeoutTimer) { clearTimeout(readyTimeoutTimer); readyTimeoutTimer = null }
    if (readyRetryTimer) { clearTimeout(readyRetryTimer); readyRetryTimer = null }
    // Native rendered these requests; their buffered console copies would dup.
    probeConsoleBuffer = []
  }

  /**
   * Give up on the native path for the current host: drop the native queue so it
   * can't later double-render, mark 'degraded' so the hot path stops retrying,
   * and flush the buffered completed-request records to the console sink.
   */
  function degradeToConsole(): void {
    sink = 'degraded'
    dispatchQueue = []
    if (readyTimeoutTimer) { clearTimeout(readyTimeoutTimer); readyTimeoutTimer = null }
    if (readyRetryTimer) { clearTimeout(readyRetryTimer); readyRetryTimer = null }
    const buffered = probeConsoleBuffer
    probeConsoleBuffer = []
    for (const r of buffered) forwardToConsole(r)
  }

  function scheduleFlush(): void {
    if (flushScheduled) return
    flushScheduled = true
    queueMicrotask(flushDispatch)
  }

  /** Trim the native queue to its cap, preferring to keep request-opening events.
   * Active requests' first events (requestWillBeSent / ...ExtraInfo) are retained
   * so later responseReceived/loadingFinished never become orphans in the panel;
   * we drop the oldest NON-opening (low-value / completion) events first. (MAJOR 2) */
  function trimQueue(): void {
    if (dispatchQueue.length <= MAX_DISPATCH_QUEUE) return
    const isOpener = (json: string): boolean =>
      json.includes('"Network.requestWillBeSent"')
      || json.includes('"Network.requestWillBeSentExtraInfo"')
    // First pass: drop oldest non-opener events.
    const kept: string[] = []
    let over = dispatchQueue.length - MAX_DISPATCH_QUEUE
    for (const json of dispatchQueue) {
      if (over > 0 && !isOpener(json)) { over--; continue }
      kept.push(json)
    }
    // If openers alone still exceed the cap, fall back to dropping oldest openers.
    if (kept.length > MAX_DISPATCH_QUEUE) {
      dispatchQueue = kept.slice(kept.length - MAX_DISPATCH_QUEUE)
    } else {
      dispatchQueue = kept
    }
  }

  function flushDispatch(): void {
    flushScheduled = false
    if (dispatchQueue.length === 0) return
    if (sink === 'degraded') { dispatchQueue = []; return }
    const wc = resolveDevtoolsWc()
    if (!wc) {
      // Host went away mid-flight. Keep the queue bounded (MAJOR 2: cap applies on
      // EVERY path, not just no-host) and wait — setDevtoolsHost re-arms probing.
      trimQueue()
      return
    }
    if (sink === 'idle') beginProbing()

    // Pack greedily up to MAX_BATCH_CHARS so one executeJavaScript stays sized
    // (MAJOR 5); oversized single messages go via the chunked transport.
    const batch: string[] = []
    let batchChars = 0
    let i = 0
    for (; i < dispatchQueue.length; i++) {
      const msg = dispatchQueue[i]!
      if (msg.length > MAX_SINGLE_DISPATCH_CHARS) {
        // Flush whatever's accumulated first to preserve ordering, then chunk.
        if (batch.length > 0) break
        dispatchChunked(wc, msg)
        continue
      }
      if (batch.length > 0 && batchChars + msg.length > MAX_BATCH_CHARS) break
      batch.push(msg)
      batchChars += msg.length
    }
    // Everything up to i was either batched or chunk-dispatched; keep the rest.
    const remaining = dispatchQueue.slice(i)

    if (batch.length === 0) {
      // Only chunked messages were processed this turn; continue with the rest.
      dispatchQueue = remaining
      if (dispatchQueue.length > 0) scheduleFlush()
      return
    }

    let script: string
    try {
      script = buildDispatchScript(batch)
    } catch {
      dispatchQueue = remaining
      if (dispatchQueue.length > 0) scheduleFlush()
      return
    }
    // Hold the rest of the queue (un-flushed) until this batch resolves so a
    // not-ready answer can re-queue the in-flight batch ahead of it in order.
    dispatchQueue = remaining
    if (remaining.length > 0) scheduleFlush()
    wc.executeJavaScript(script, true).then((ok) => {
      if (ok === true) {
        if (sink !== 'ready') markReady()
        return
      }
      // API not present yet — front-end still booting. Re-queue this batch ahead
      // of any newer events and poll until ready (or the timeout degrades us).
      if (sink === 'degraded') return
      dispatchQueue = batch.concat(dispatchQueue)
      trimQueue()
      scheduleReadyRetry()
    }).catch(() => {
      // wc navigated / torn down mid-call, OR the script overflowed IPC. Re-queue
      // (bounded) and let the next flush re-resolve the host. Best-effort; the
      // ready-timeout still governs giving up. (MAJOR 5: backoff via retry timer.)
      if (sink === 'degraded') return
      dispatchQueue = batch.concat(dispatchQueue)
      trimQueue()
      scheduleReadyRetry()
    })
  }

  function dispatchChunked(wc: WebContents, msg: string): void {
    const totalSize = msg.length
    const chunks: string[] = []
    for (let i = 0; i < msg.length; i += CHUNK_CHARS) {
      chunks.push(msg.slice(i, i + CHUNK_CHARS))
    }
    let script: string
    try {
      script = buildChunkedDispatchScript(chunks, totalSize)
    } catch {
      return
    }
    wc.executeJavaScript(script, true).catch(() => { /* best-effort */ })
  }

  function scheduleReadyRetry(): void {
    if (readyRetryTimer || sink === 'ready' || sink === 'degraded') return
    readyRetryTimer = setTimeout(() => {
      readyRetryTimer = null
      if (sink === 'degraded') return
      if (dispatchQueue.length > 0) scheduleFlush()
    }, READY_RETRY_MS)
  }

  /** Queue one raw (already-namespaced) CDP message for native dispatch. */
  function enqueueNative(method: string, params: unknown): void {
    // The native queue only accumulates when a host EXISTS (probing/ready). In
    // 'idle' (no host) or 'degraded' the console is the sole sink for these
    // requests — queueing them would let them double-render if a host later
    // arrives / swaps in. resolveDevtoolsWc() guards the idle case where a host
    // is set on the bridge but applyDevtoolsHost hasn't run yet.
    if (sink === 'degraded') return
    if (sink === 'idle' && !resolveDevtoolsWc()) return
    let json: string
    try {
      json = JSON.stringify({ method, params })
    } catch {
      // A value CDP serialized but we can't re-serialize — drop, never throw.
      return
    }
    dispatchQueue.push(json)
    trimQueue()
    scheduleFlush()
  }

  // ── console fallback ──────────────────────────────────────────────────────

  /** Re-emit a completed request into the service host's console (fallback). */
  function forwardToConsole(record: NetworkRequestRecord): void {
    const wc = bridge.getServiceWc()
    if (!wc || wc.isDestroyed()) return
    let script: string
    try {
      script = buildForwardScript(record)
    } catch {
      return
    }
    wc.executeJavaScript(script, true).catch(() => {})
  }

  function detachSimulator(): void {
    const wc = simWc
    simWc = null
    const ad = attachDisposables
    attachDisposables = null
    if (ad) void ad.disposeAll().catch(() => {})
    // Drop any queued-but-unflushed messages so a new attach starts clean, and
    // reset the native-sink state machine (the next attach re-probes the host).
    dispatchQueue = []
    probeConsoleBuffer = []
    // A new simulator attach restarts the native sink: 'idle' until the next
    // event re-probes the (possibly already-set) host.
    sink = 'idle'
    if (readyRetryTimer) { clearTimeout(readyRetryTimer); readyRetryTimer = null }
    if (readyTimeoutTimer) { clearTimeout(readyTimeoutTimer); readyTimeoutTimer = null }
    if (!wc || wc.isDestroyed()) return
    try {
      if (wc.debugger.isAttached()) wc.debugger.detach()
    } catch { /* already detached / mid-destroy */ }
  }

  function attachSimulator(wc: WebContents): void {
    if (!wc || wc.isDestroyed()) return
    if (simWc === wc && !wc.isDestroyed()) return
    detachSimulator()

    try {
      if (!wc.debugger.isAttached()) {
        wc.debugger.attach('1.3')
      }
    } catch (err) {
      console.warn('[network-forward] debugger.attach failed; simulator network not captured:', err instanceof Error ? err.message : err)
      return
    }

    simWc = wc
    const attach = new DisposableRegistry()
    attachDisposables = attach

    // Per-attach requestId namespace: a fresh epoch each attach guarantees ids
    // from a previous simulator session can never collide with this one.
    const ns = new RequestIdNamespace(String(Date.now()))

    // Fallback bookkeeping: requestId → in-flight request, for the console line
    // when the native dispatch path is unusable.
    const pending = new Map<string, Pending>()

    const onMessage = (_event: Electron.Event, method: string, params: unknown): void => {
      // ── Primary sink: forward the raw CDP event into the DevTools front-end ──
      if (FORWARDED_METHODS.has(method)) {
        const rewritten = rewriteRequestId(method, params, ns)
        enqueueNative(rewritten.method, rewritten.params)
      } else if (REWRITE_REQUEST_ID_METHODS.has(method)) {
        // Methods we namespace but don't forward (dataReceived, 二期): still
        // resolve so the id mapping stays coherent if forwarding is added later.
        rewriteRequestId(method, params, ns)
      }

      // ── Fallback bookkeeping (used only when native dispatch is unusable) ──
      switch (method) {
        case 'Network.requestWillBeSent': {
          const p = params as RequestWillBeSent
          if (!p?.request) return
          if (pending.size >= MAX_PENDING) pending.clear()
          pending.set(p.requestId, { url: p.request.url, method: p.request.method, status: 0 })
          break
        }
        case 'Network.responseReceived': {
          const p = params as ResponseReceived
          const req = pending.get(p.requestId)
          if (req) req.status = p.response?.status ?? 0
          break
        }
        case 'Network.loadingFinished': {
          const p = params as { requestId: string }
          const req = pending.get(p.requestId)
          if (!req) return
          pending.delete(p.requestId)
          maybeFallback({ source: 'service', url: req.url, method: req.method, status: req.status })
          break
        }
        case 'Network.loadingFailed': {
          const p = params as LoadingFailed
          const req = pending.get(p.requestId)
          if (!req) return
          pending.delete(p.requestId)
          maybeFallback({
            source: 'service',
            url: req.url,
            method: req.method,
            status: req.status,
            errorText: p.canceled ? 'canceled' : (p.errorText || 'failed'),
          })
          break
        }
        default:
          break
      }
    }

    wc.debugger.on('message', onMessage)
    attach.add(() => {
      try { wc.debugger.removeListener('message', onMessage) } catch { /* wc gone */ }
    })

    const onDetach = (): void => { if (simWc === wc) { simWc = null } }
    wc.debugger.on('detach', onDetach)
    attach.add(() => {
      try { wc.debugger.removeListener('detach', onDetach) } catch { /* wc gone */ }
    })

    const onDestroyed = (): void => {
      if (simWc === wc) {
        simWc = null
        const ad = attachDisposables
        attachDisposables = null
        if (ad) void ad.disposeAll().catch(() => {})
      }
    }
    // Route the destroyed-teardown through the connection registry when one is
    // available (deterministic disposal on wc destroy / connection reset);
    // otherwise keep the bespoke `once('destroyed')` watcher. WHAT onDestroyed
    // does is unchanged — only WHERE it's registered.
    const reg = bridge.connections
    if (reg) {
      const owned = reg.acquire(wc).own(onDestroyed)
      attach.add(() => owned.dispose())
    } else {
      wc.once('destroyed', onDestroyed)
      attach.add(() => {
        try { wc.removeListener('destroyed', onDestroyed) } catch { /* wc gone */ }
      })
    }

    void wc.debugger.sendCommand('Network.enable').catch((err) => {
      console.warn('[network-forward] Network.enable failed:', err instanceof Error ? err.message : err)
    })
  }

  /**
   * Route a completed request to EXACTLY ONE sink, per the native-sink state
   * machine (MAJOR 1 — no double-display):
   *  - 'ready'    : native path already rendered it → suppress console.
   *  - 'degraded' : native abandoned → console.
   *  - 'idle'     : no host configured → console (the native queue never flushes).
   *  - 'probing'  : undecided → buffer the record; we'll either drop it (on ready)
   *                 or flush it to console (on degrade). Bounded so it can't grow.
   */
  function maybeFallback(record: NetworkRequestRecord): void {
    // 'idle' but a host is resolvable (set via the bridge, applyDevtoolsHost not
    // run): the native path is in play, so promote to 'probing' instead of
    // console — otherwise this completion would later double-render natively.
    if (sink === 'idle' && resolveDevtoolsWc()) beginProbing()
    switch (sink) {
      case 'ready':
        return
      case 'probing':
        if (probeConsoleBuffer.length >= MAX_PENDING) probeConsoleBuffer.shift()
        probeConsoleBuffer.push(record)
        return
      case 'degraded':
      case 'idle':
      default:
        forwardToConsole(record)
    }
  }

  /** Apply a new (or cleared) DevTools host: reset sink state and (re)probe. */
  function applyDevtoolsHost(wc: WebContents | null): void {
    devtoolsHostDisposable?.dispose()
    devtoolsHostDisposable = null
    devtoolsWc = wc && !wc.isDestroyed() ? wc : null

    // Reset the native-sink state machine for the new host.
    if (readyTimeoutTimer) { clearTimeout(readyTimeoutTimer); readyTimeoutTimer = null }
    if (readyRetryTimer) { clearTimeout(readyRetryTimer); readyRetryTimer = null }
    // Records buffered while probing the OLD host are stale — drop, don't flush
    // (their native copies were already queued; on a host swap we restart clean).
    probeConsoleBuffer = []

    if (!devtoolsWc) {
      // No host → 'idle': completions go straight to console; native queue is
      // moot, drop it so it can't double-render if a host later appears.
      sink = 'idle'
      dispatchQueue = []
      return
    }

    // Host present: watch it so its destruction equals setDevtoolsHost(null)
    // WITHOUT touching view-manager (host-destroyed cleanup lives here). Begin
    // probing and flush anything already queued.
    const host = devtoolsWc
    const onHostDestroyed = (): void => { applyDevtoolsHost(null) }
    // Route host-destroyed teardown through the connection registry when present
    // (the Connection fires onHostDestroyed on wc destroy / reset, and the
    // returned Disposable releases the ownership early on host swap/clear);
    // otherwise keep the bespoke `once('destroyed')` watcher. The
    // `typeof host.once === 'function'` guard stays on the fallback so minimal
    // test fakes / odd hosts don't throw.
    const reg = bridge.connections
    // `acquire(host)` internally arms `host.once('destroyed')`, so it must be
    // gated by the SAME `typeof host.once === 'function'` guard the fallback
    // uses — otherwise a minimal/fake DevTools host (no emitter) throws on the
    // connection path where the fallback would safely no-op.
    if (reg && typeof host.once === 'function') {
      const owned = reg.acquire(host).own(onHostDestroyed)
      devtoolsHostDisposable = toDisposable(() => owned.dispose())
    } else {
      if (typeof host.once === 'function') host.once('destroyed', onHostDestroyed)
      devtoolsHostDisposable = toDisposable(() => {
        try { host.removeListener?.('destroyed', onHostDestroyed) } catch { /* gone */ }
      })
    }

    beginProbing()
    if (dispatchQueue.length > 0) scheduleFlush()
  }

  registry.add(() => {
    devtoolsHostDisposable?.dispose()
    devtoolsHostDisposable = null
    if (readyTimeoutTimer) { clearTimeout(readyTimeoutTimer); readyTimeoutTimer = null }
    if (readyRetryTimer) { clearTimeout(readyRetryTimer); readyRetryTimer = null }
  })
  registry.add(() => detachSimulator())

  return {
    attachSimulator,
    detachSimulator,
    setDevtoolsHost: (wc) => applyDevtoolsHost(wc),
    // report() has no observing debugger, so there's no live CDP event to push
    // natively — surface it via the console fallback line.
    report: (record) => forwardToConsole(record),
    dispose: () => registry.disposeAll(),
  }
}
