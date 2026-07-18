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
 * inspects — so they are otherwise invisible in the Network panel. This service
 * surfaces them.
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
 * i.e. the events appear as activity on the currently-inspected target. Child-
 * target routing (`Target.attachedToTarget` + hooking outbound CDP) is deferred.
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
 *  ✅ Response body / preview and request post data: prefetched from the
 *     simulator's CDP session at loadingFinished into a bounded cache keyed by
 *     the VIRTUAL id (`bodies`, see NetworkBodyProvider). The front-end's
 *     `Network.getResponseBody` / `Network.getRequestPostData` round-trips for
 *     `dimina:sim:` ids are intercepted by the outbound CDP gate that
 *     elements-forward installs on `InspectorFrontendHost.sendMessageToBackend`
 *     and answered from that cache — the service-host backend the front-end
 *     natively talks to has never heard of these ids.
 *  ⏳ TODO: `dataReceived` per-chunk forwarding (skipped to avoid an
 *     executeJavaScript per chunk).
 *  ✅ Requests issued from inside a render-host `<webview>` guest (page-level
 *     resource loads / page `fetch`, tagged `source: 'render'`) — `attachRenderGuest`
 *     acquires a lease from the shared `CdpSessionBroker` (cdp-session/index.ts),
 *     which is single owner of every render-guest `wc.debugger` session across
 *     this forwarder, safe-area, elements-forward and render-inspect. An
 *     external detach (another owner releasing the shared session, or a real
 *     Chrome DevTools window) self-heals via the lease's `onDetach` — capture
 *     re-wires itself even though `attachRenderGuest` is only ever called ONCE
 *     per guest (at webview creation).
 *  ⚠️ NOT observable by any `webContents.debugger`: a request a host module issues
 *     directly from the MAIN process. Those need an explicit `report()` call
 *     (exposed below; it uses the console fallback path).
 */
import type { WebContents } from 'electron'
import { SyncDisposableRegistry, toDisposable, type ConnectionRegistry, type Disposable } from '@dimina-kit/electron-deck/main'
import { isFrontendSettled } from '../views/inject-when-ready.js'
import { packDispatchBatch } from './dispatch-batch.js'
import { PrefetchCache, DEFAULT_PER_ENTRY_MAX_CHARS } from './body-cache.js'
import { PROBE_DEVTOOLS_API, MAX_SINGLE_DISPATCH_CHARS, CHUNK_CHARS, buildChunkedDispatchScript } from './frontend-dispatch.js'
import { createCdpSessionBroker, type CdpSessionBroker, type CdpSessionLease } from '../cdp-session/index.js'

/**
 * Namespace prefix of every virtual requestId this forwarder injects into the
 * DevTools front-end. SINGLE SOURCE for the literal: the front-end outbound
 * gate (elements-forward) keys its `Network.getResponseBody` /
 * `Network.getRequestPostData` interception on this exact prefix, so the two
 * modules can never drift apart on what counts as "one of ours".
 */
export const VIRTUAL_REQUEST_ID_PREFIX = 'dimina:sim:'

/** CDP `Network.getResponseBody` result shape (served from the prefetch cache). */
export interface CdpResponseBody {
  body: string
  base64Encoded: boolean
}

/**
 * Answers the front-end's body/post-data lookups for virtual requestIds. The
 * outbound CDP gate (elements-forward) consumes this: it intercepts the
 * front-end's `Network.getResponseBody` / `Network.getRequestPostData` for
 * `dimina:sim:` ids (the service-host backend has never heard of them) and
 * replies from here instead. Rejections carry the same not-found message a
 * real CDP backend produces for an unknown requestId.
 */
export interface NetworkBodyProvider {
  getResponseBody(requestId: string): Promise<CdpResponseBody>
  getRequestPostData(requestId: string): Promise<{ postData: string }>
}

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
  /**
   * Shared CDP session broker (see cdp-session/index.ts) that owns every
   * render-guest AND simulator debugger session's attach/detach lifecycle —
   * safe-area, elements-forward, render-inspect and simulator-storage acquire
   * leases from the same instance. Absent → a private broker is created and
   * owned for this forwarder's lifetime (torn down on `dispose()`), so
   * existing standalone callers/tests compile and behave unchanged, just
   * without cross-module session sharing. Both `attachRenderGuest` and
   * `attachSimulator` go through it — see detachSimulator's docstring for why
   * the simulator path never forces a physical detach either.
   */
  broker?: CdpSessionBroker
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
   * Wire a render-host guest wc (pageFrame) for Network capture — page-level
   * resource loads (images/fonts/page fetch) that never touch the simulator's
   * network stack. Idempotent per wc. Acquires a lease from the shared
   * `CdpSessionBroker` (cdp-session/index.ts) — reuses an already-attached
   * session (safe-area / elements-forward / render-inspect may have attached
   * first) or self-attaches when no one has; the broker alone decides who may
   * detach. Self-heals after an external detach (the lease's `onDetach`
   * re-wires automatically) even though this is only ever called ONCE per
   * guest, at webview creation. Events share the simulator capture's
   * virtual-id namespace prefix (distinct epochs keep them collision-free) and
   * the same body prefetch cache.
   */
  attachRenderGuest(wc: WebContents): void
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
  /**
   * Body/post-data lookups for the virtual requestIds this forwarder injected,
   * backed by the loadingFinished-time prefetch cache. Keyed by virtual id, so
   * entries stay valid across detach/re-attach (each attach epoch mints
   * non-colliding ids); dispose() drops them all.
   */
  readonly bodies: NetworkBodyProvider
}

// ── requestId namespacing (pure, testable) ──────────────────────────────────

/**
 * CDP events whose `params.requestId` we rewrite into the virtual namespace.
 * Anything carrying a requestId must be namespaced consistently — even methods
 * we don't (yet) forward — so the raw→virtual map stays coherent if forwarding
 * is widened later. `requestServedFromCache` and `resourceChangedPriority` are
 * included for that reason (rewrite-only today, not forwarded).
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
    const virtual = `${VIRTUAL_REQUEST_ID_PREFIX}${this.epoch}:${this.seq++}:${rawId}`
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

/** CDP `Network.requestWillBeSent` params slice the fallback + prefetch read. */
interface RequestWillBeSent {
  requestId: string
  request: { url: string; method: string; hasPostData?: boolean; postData?: string }
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
  const registry = new SyncDisposableRegistry()
  let disposed = false

  // ── Response body / post-data prefetch (serves the front-end's clicks) ─────
  // Keyed by VIRTUAL requestId and owned by the forwarder (not the attach):
  // epochs make ids non-colliding, so entries stay servable across a simulator
  // detach/re-attach while the panel still shows the old rows. Bounded + TTL'd
  // in the cache itself.
  const bodyCache = new PrefetchCache<CdpResponseBody>((v) => v.body.length)
  const postDataCache = new PrefetchCache<{ postData: string }>((v) => v.postData.length)

  // ── Prefetch admission control ──────────────────────────────────────────────
  // Every completed request (simulator + all render guests combined — this
  // counter is forwarder-wide, not per-attach) would otherwise trigger an
  // unconditional `Network.getResponseBody` CDP round-trip that must
  // materialize the FULL body into main-process memory before the cache's own
  // per-entry/total-size limits can reject it (those limits apply only to
  // SETTLED entries — a pending fetch counts 0 and is eviction-exempt). A page
  // that finishes many large resources at once (e.g. many concurrent images —
  // exactly the render-guest capture path) could otherwise pile up unboundedly
  // many simultaneous full-body reads. This caps how many prefetches (body +
  // post-data combined) may be in flight at once; once at the cap, further
  // completions are simply skipped — the panel's Response tab 404s for those
  // (same as any other not-found id) rather than the process risking a memory
  // spike. `primeWithAdmission`'s bookkeeping only counts a slot when the cache
  // actually started a new fetch (PrefetchCache.prime()'s idempotent no-op
  // return doesn't consume one).
  const MAX_CONCURRENT_PREFETCHES = 32
  let pendingPrefetchCount = 0
  /**
   * `fetch` MUST be an `async` function (both current call sites in
   * `prefetchBodies` are). An `async` function can never throw synchronously —
   * any exception in its body is spec-guaranteed to surface as a rejected
   * promise instead — which is what guarantees `release()` always eventually
   * runs via the `.then()` below. A plain (non-async) function that throws
   * synchronously when CALLED would bypass `.then()` entirely and leak this
   * slot forever (`PrefetchCache.prime` catches that synchronous throw and
   * still reports `started: true`), so never pass one here.
   */
  function primeWithAdmission<V>(cache: PrefetchCache<V>, id: string, fetch: () => Promise<V>): void {
    if (pendingPrefetchCount >= MAX_CONCURRENT_PREFETCHES) return
    pendingPrefetchCount++
    let released = false
    const release = (): void => { if (!released) { released = true; pendingPrefetchCount-- } }
    const started = cache.prime(id, () => fetch().then(
      (v) => { release(); return v },
      (err) => { release(); throw err },
    ))
    if (!started) release()
  }

  // The simulator WCV we currently have a debugger session on, our broker
  // lease for it, and the per-attach teardown (message listener). Null when
  // not attached.
  let simWc: WebContents | null = null
  let simLease: CdpSessionLease | null = null
  let attachDisposables: SyncDisposableRegistry | null = null

  // Render-host guests wired for capture: wc.id → SYNCHRONOUS per-guest
  // teardown (message listener + broker lease). Attach/detach ownership for
  // these sessions lives entirely in the shared broker now (see cdp-session/
  // index.ts) — this map only tracks OUR OWN wiring (the 'message' listener
  // wireNetworkCapture installs), not who may detach the underlying session.
  const guestWired = new Map<number, SyncDisposableRegistry>()
  // wc.id → the generation token of the most recently scheduled render-guest
  // retry (acquire refused, or an established session got detached).
  // `guestWired` alone cannot de-duplicate repeat `attachRenderGuest` calls
  // during this window — it is only populated on a SUCCESSFUL acquire — so
  // without this, calling `attachRenderGuest(wc)` again while the exclusive
  // holder keeps refusing spawns a second, independent 300ms retry chain.
  // A bare presence flag is NOT enough: a stale timer from an EARLIER retry
  // cycle (superseded by an intervening successful reattach, itself followed
  // by a fresh detach that scheduled its own new retry) would, on firing,
  // unconditionally clear whatever is recorded — including that newer retry's
  // own marker — and then reschedule itself, forking back into two parallel
  // chains. A monotonic generation token lets a fired timer recognize its own
  // staleness (its captured token no longer matches the current one) and
  // no-op instead of touching state it no longer owns.
  const guestRetryGeneration = new Map<number, number>()
  let nextRenderGuestRetryGeneration = 0
  // Own (and dispose on this forwarder's own dispose()) a private broker only
  // when the caller didn't supply a shared one.
  const ownsBroker = !bridge.broker
  const broker = bridge.broker ?? createCdpSessionBroker({ connections: bridge.connections })

  // The DevTools front-end host wc (primary sink), set by the ViewManager.
  let devtoolsWc: WebContents | null = null
  // Teardown for the wc 'destroyed' watcher on the current host (clears the host).
  let devtoolsHostDisposable: Disposable | null = null

  // ── Native-sink state machine ─────────────────────────────────────────────
  let sink: SinkState = 'idle'
  // Buffered completed-request records while 'probing' — flushed to console if we
  // degrade, dropped if we go ready (so a request shows in exactly one sink).
  let probeConsoleBuffer: NetworkRequestRecord[] = []
  let readyTimeoutTimer: ReturnType<typeof setTimeout> | null = null
  // Wall-clock deadline for the CURRENT probe, set once when 'probing' begins.
  // scheduleReadyRetry() re-checks this on every retry so the retry chain is
  // itself authoritative on giving up — it does not depend on winning a race
  // against readyTimeoutTimer firing first (two timers due at the same virtual
  // instant have no guaranteed firing order under fake timers, which let a
  // never-ready host's retry chain outlive the nominal timeout in CI: an
  // "Aborting after running 10000 timers" abort in `network-forward`'s
  // ready-timeout test). readyTimeoutTimer stays as a backstop for hosts that
  // never retry at all (e.g. the queue drains before the deadline).
  let probeDeadline: number | null = null

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
    probeDeadline = Date.now() + DEVTOOLS_READY_TIMEOUT_MS
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
    probeDeadline = null
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
    probeDeadline = null
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
   * we drop the oldest NON-opening (low-value / completion) events first. */
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
      // Host went away mid-flight. Keep the queue bounded (the cap applies on
      // EVERY path, not just no-host) and wait — setDevtoolsHost re-arms probing.
      trimQueue()
      return
    }
    if (!isFrontendSettled(wc)) {
      // An unsettled front-end can't run the dispatch script anyway — and every
      // executeJavaScript against it queues one did-stop-loading waiter on the
      // emitter, so a relaunch's network burst piles them past the MaxListeners
      // ceiling. MUST be the shared Electron-aligned predicate (a bare
      // isLoading() probe diverges from the internal isLoadingMainFrame gate).
      // Hold the (bounded) queue; the next event's flush or the ready-retry
      // delivers after the load.
      trimQueue()
      scheduleReadyRetry()
      return
    }
    if (sink === 'idle') beginProbing()

    // Pack greedily up to MAX_BATCH_CHARS so one executeJavaScript stays sized;
    // oversized single messages go via the chunked transport (see packDispatchBatch).
    const { batch, chunked, remaining } = packDispatchBatch(dispatchQueue, MAX_SINGLE_DISPATCH_CHARS, MAX_BATCH_CHARS)
    for (const msg of chunked) dispatchChunked(wc, msg)

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
      // ready-timeout still governs giving up. Backoff is via the retry timer.
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
    // Self-terminate on the same deadline readyTimeoutTimer enforces, instead of
    // trusting that timer to win a same-instant race against this one (see the
    // comment on `probeDeadline`'s declaration).
    if (probeDeadline !== null && Date.now() >= probeDeadline) {
      degradeToConsole()
      return
    }
    readyRetryTimer = setTimeout(() => {
      readyRetryTimer = null
      if (sink === 'degraded') return
      if (probeDeadline !== null && Date.now() >= probeDeadline) {
        degradeToConsole()
        return
      }
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

  /**
   * Stop USING the simulator wc's session. Releases our own lease (message
   * listener + Network capture wiring) but never forces a physical
   * `debugger.detach()` — this same simulator wc's debugger session is also
   * independently used by simulator-storage (DOMStorage capture), and an
   * unconditional detach here would kill ITS capture too, exactly like an
   * unconditional detach on ITS side would kill ours. The broker (see
   * cdp-session/index.ts) is the only thing that decides when an actual
   * detach happens (wc destroy, or its own top-level dispose() for a
   * self-attached session) — never a single consumer switching away.
   */
  function detachSimulator(): void {
    simWc = null
    const lease = simLease
    simLease = null
    const ad = attachDisposables
    attachDisposables = null
    if (ad) { try { ad.disposeAll() } catch { /* best-effort teardown */ } }
    lease?.dispose()
    // Drop any queued-but-unflushed messages so a new attach starts clean, and
    // reset the native-sink state machine (the next attach re-probes the host).
    dispatchQueue = []
    probeConsoleBuffer = []
    // A new simulator attach restarts the native sink: 'idle' until the next
    // event re-probes the (possibly already-set) host.
    sink = 'idle'
    probeDeadline = null
    if (readyRetryTimer) { clearTimeout(readyRetryTimer); readyRetryTimer = null }
    if (readyTimeoutTimer) { clearTimeout(readyTimeoutTimer); readyTimeoutTimer = null }
  }

  /**
   * Wire one wc's already-usable debugger session for Network capture: a fresh
   * per-attach requestId namespace (epochs keep ids from ever colliding across
   * sources/attaches), the raw-event forward into the DevTools front-end, the
   * loadingFinished-time body/post-data prefetch, and the console-fallback
   * bookkeeping (tagged with `source`). Shared verbatim by the simulator
   * attach (owner semantics) and every render-guest attach (shared-session
   * semantics) — the capture pipeline is identical, only session ownership
   * differs. The 'message' listener teardown is registered on `attach`.
   */
  function wireNetworkCapture(wc: WebContents, source: NetworkSource, attach: SyncDisposableRegistry, epoch: string): void {
    const ns = new RequestIdNamespace(epoch)

    // Fallback bookkeeping: requestId → in-flight request, for the console line
    // when the native dispatch path is unusable.
    const pending = new Map<string, Pending>()

    // Raw ids whose requestWillBeSent announced a post body that was NOT
    // inlined (`hasPostData` without `postData`) — the only case the front-end
    // round-trips `Network.getRequestPostData`. Consumed at loadingFinished.
    const postDataWanted = new Set<string>()

    /**
     * Prefetch the response body (and, when flagged, the post data) from this
     * wc's CDP session the moment the request finishes — the renderer may
     * evict the resource soon after, so a click-time fetch would race it.
     * Gated exactly like event forwarding: with no devtools host to serve
     * (idle-without-host / degraded) there is no panel to click, so buffering
     * bodies would only burn memory.
     */
    const prefetchBodies = (rawId: string, encodedDataLength?: number): void => {
      if (sink === 'degraded') return
      if (sink === 'idle' && !resolveDevtoolsWc()) return
      const virtualId = ns.resolve(rawId)
      // Skip the CDP round-trip entirely for a response already known (from
      // the wire size CDP reports at completion) to exceed the cache's own
      // per-entry ceiling — no point materializing a full body into main-
      // process memory just to have the cache reject it after the fact. This
      // is a best-effort heuristic (encodedDataLength is the ON-THE-WIRE size;
      // a decompressed body can be larger), not a hard guarantee — the
      // concurrency cap below is what actually bounds worst-case memory.
      const knownOversized = typeof encodedDataLength === 'number' && encodedDataLength > DEFAULT_PER_ENTRY_MAX_CHARS
      if (!knownOversized) {
        primeWithAdmission(bodyCache, virtualId, async (): Promise<CdpResponseBody> => {
          const raw: unknown = await wc.debugger.sendCommand('Network.getResponseBody', { requestId: rawId })
          const r = raw as { body?: unknown, base64Encoded?: unknown } | null | undefined
          if (!r || typeof r.body !== 'string') throw new Error('response body unavailable')
          return { body: r.body, base64Encoded: r.base64Encoded === true }
        })
      }
      if (!postDataWanted.delete(rawId)) return
      primeWithAdmission(postDataCache, virtualId, async (): Promise<{ postData: string }> => {
        const raw: unknown = await wc.debugger.sendCommand('Network.getRequestPostData', { requestId: rawId })
        const r = raw as { postData?: unknown } | null | undefined
        if (!r || typeof r.postData !== 'string') throw new Error('post data unavailable')
        return { postData: r.postData }
      })
    }

    // ── Fallback bookkeeping handlers — one per Network.* method, each kept
    // simple so `onMessage` itself stays a flat dispatch (not a branchy switch). ──

    function onRequestWillBeSent(params: unknown): void {
      const p = params as RequestWillBeSent
      if (!p?.request) return
      if (pending.size >= MAX_PENDING) pending.clear()
      pending.set(p.requestId, { url: p.request.url, method: p.request.method, status: 0 })
      // A body announced but not inlined is the one case the panel will
      // round-trip `Network.getRequestPostData` — flag it for prefetch.
      if (p.request.hasPostData === true && typeof p.request.postData !== 'string') {
        if (postDataWanted.size >= MAX_PENDING) postDataWanted.clear()
        postDataWanted.add(p.requestId)
      }
    }

    function onResponseReceived(params: unknown): void {
      const p = params as ResponseReceived
      const req = pending.get(p.requestId)
      if (req) req.status = p.response?.status ?? 0
    }

    function onLoadingFinished(params: unknown): void {
      const p = params as { requestId: string, encodedDataLength?: number }
      if (typeof p?.requestId === 'string') prefetchBodies(p.requestId, p.encodedDataLength)
      const req = pending.get(p.requestId)
      if (!req) return
      pending.delete(p.requestId)
      maybeFallback({ source, url: req.url, method: req.method, status: req.status })
    }

    function onLoadingFailed(params: unknown): void {
      const p = params as LoadingFailed
      postDataWanted.delete(p?.requestId)
      const req = pending.get(p.requestId)
      if (!req) return
      pending.delete(p.requestId)
      maybeFallback({
        source,
        url: req.url,
        method: req.method,
        status: req.status,
        errorText: p.canceled ? 'canceled' : (p.errorText || 'failed'),
      })
    }

    const FALLBACK_HANDLERS: Readonly<Record<string, (params: unknown) => void>> = {
      'Network.requestWillBeSent': onRequestWillBeSent,
      'Network.responseReceived': onResponseReceived,
      'Network.loadingFinished': onLoadingFinished,
      'Network.loadingFailed': onLoadingFailed,
    }

    const onMessage = (_event: Electron.Event, method: string, params: unknown): void => {
      // ── Primary sink: forward the raw CDP event into the DevTools front-end ──
      if (FORWARDED_METHODS.has(method)) {
        const rewritten = rewriteRequestId(method, params, ns)
        enqueueNative(rewritten.method, rewritten.params)
      } else if (REWRITE_REQUEST_ID_METHODS.has(method)) {
        // Methods we namespace but don't forward (dataReceived): still resolve
        // so the id mapping stays coherent if forwarding is added later.
        rewriteRequestId(method, params, ns)
      }

      // ── Fallback bookkeeping (used only when native dispatch is unusable) ──
      FALLBACK_HANDLERS[method]?.(params)
    }

    wc.debugger.on('message', onMessage)
    attach.add(() => {
      try { wc.debugger.removeListener('message', onMessage) } catch { /* wc gone */ }
    })
  }

  /** Drop one guest's wiring (message listener + broker lease). Attach/detach
   *  ownership of the underlying session is entirely the broker's concern. */
  function cleanupGuest(wcId: number): void {
    const teardown = guestWired.get(wcId)
    guestWired.delete(wcId)
    teardown?.disposeAll()
  }

  /**
   * A hot-reload respawn replaces the render-host `<webview>` guest with a
   * fresh one (see simulator-app.tsx's ready-then-swap session commit); the
   * OLD guest's wc is closed asynchronously as part of the old session's
   * teardown (bridge-router's `closeSessionPages`), so there is a window
   * where `wc.isDestroyed()` is still `false` but the debugger session is
   * already gone (Electron reports `detach` with reason `"target closed"` —
   * confirmed via instrumentation against a real respawn: every detach in
   * that run carried this exact reason, one per closing guest, never a
   * repeated storm on one guest). Retrying the re-attach INLINE on every
   * `detach` (no delay) raced that async teardown: each re-attach attempt
   * landed inside the still-closing window and immediately produced another
   * `detach`, self-sustaining a tight synchronous loop (confirmed by
   * instrumentation: thousands of attach/detach cycles within a couple
   * seconds) until the wc finally finished closing — there is no public
   * Electron event for "this wc's close is about to complete", so the only
   * available signal to end the loop is `wc.isDestroyed()` itself, which the
   * retry already checks. This delay does not wait for any timing to
   * "settle" — it only paces the retry slower than the async close, so the
   * loop's real termination check (`wc.isDestroyed()` / `disposed`) has a
   * chance to observe the close having finished before the next attempt.
   */
  const RENDER_GUEST_REATTACH_DELAY_MS = 300

  /**
   * Schedule one more `wireRenderGuest(wc)` attempt after
   * `RENDER_GUEST_REATTACH_DELAY_MS`, guarded so a guest that has since been
   * destroyed (or a forwarder that has since been disposed) never gets a
   * stray retry. Shared by both places capture can fail to be wired: an
   * established session later getting detached, AND `broker.acquire()`
   * itself refusing on the very first attempt (the session is exclusively
   * held elsewhere, e.g. a real Chrome DevTools window) — that second case
   * used to give up permanently instead of retrying, so capture never
   * recovered even once the holder released it.
   *
   * De-duplicated via `guestRetryGeneration`: a repeat `attachRenderGuest(wc)`
   * call while one guest's retry is already pending must join the SAME
   * chain, not start an independent second one — `guestWired` alone cannot
   * catch this because it is only populated once acquire actually succeeds.
   * Each schedule mints a fresh generation token; the fired timer only acts
   * if its captured token is still the current one, so a stale timer whose
   * generation has since been superseded silently no-ops instead of clearing
   * (and forking) a newer retry's bookkeeping.
   */
  function scheduleRenderGuestRetry(wc: WebContents): void {
    if (wc.isDestroyed()) return
    if (guestRetryGeneration.has(wc.id)) return
    const generation = ++nextRenderGuestRetryGeneration
    guestRetryGeneration.set(wc.id, generation)
    const timer = setTimeout(() => {
      if (guestRetryGeneration.get(wc.id) !== generation) return
      guestRetryGeneration.delete(wc.id)
      if (!disposed && !wc.isDestroyed()) wireRenderGuest(wc)
    }, RENDER_GUEST_REATTACH_DELAY_MS)
    // Best-effort: if the whole forwarder tears down before this fires, there
    // is nothing to clear it from — the disposed check above is the guard.
    timer.unref?.()
  }

  /**
   * Wire one render guest for Network capture via the shared broker.
   *
   * The lease's `onDetach` fires on EITHER an external detach (another owner
   * releasing the shared session, or a real Chrome DevTools window stealing
   * it) OR the guest being destroyed (see cdp-session/index.ts) — either way
   * our wiring is torn down and, if the guest is still alive, re-wired (after
   * `RENDER_GUEST_REATTACH_DELAY_MS`) so capture self-heals. Previously
   * `attachRenderGuest` only ever ran ONCE per guest (at webview creation,
   * from `did-attach-webview`), so any detach permanently killed capture for
   * that guest's remaining lifetime — nothing else ever called it again.
   *
   * `guestWired` alone guards re-entry once successfully wired. A repeat call
   * while acquire keeps failing is deliberately NOT blocked here (only the
   * TIMER that call would schedule is de-duplicated, in
   * `scheduleRenderGuestRetry`) — an explicit re-attach right after a detach
   * must still get its own immediate `acquire()` attempt (the exclusive
   * holder may have already released it by then), not be forced to wait out
   * a stale pending window.
   */
  function wireRenderGuest(wc: WebContents): void {
    if (guestWired.has(wc.id)) return
    const lease = broker.acquire(wc)
    if (!lease) {
      // Not terminal — the exclusive holder may release the session later.
      // Retry on the same cadence as the onDetach self-heal below, or this
      // guest's capture would die for its whole remaining lifetime the very
      // first time acquire() lost the race.
      scheduleRenderGuestRetry(wc)
      return
    }

    // This wc is now genuinely wired — drop any stale pending-retry
    // generation (e.g. from an earlier detach cycle superseded by THIS
    // successful acquire) so a LATER detach can freely mint its own fresh
    // generation instead of being silently swallowed by a leftover entry.
    guestRetryGeneration.delete(wc.id)
    const teardown = new SyncDisposableRegistry()
    guestWired.set(wc.id, teardown)
    wireNetworkCapture(wc, 'render', teardown, `g${wc.id}-${Date.now()}`)

    const detachSub = lease.onDetach(() => {
      cleanupGuest(wc.id)
      scheduleRenderGuestRetry(wc)
    })
    teardown.add(() => {
      detachSub.dispose()
      lease.dispose()
    })

    void lease.send('Network.enable').catch((err) => {
      console.warn('[network-forward] guest Network.enable failed:', err instanceof Error ? err.message : err)
    })
  }

  function attachRenderGuest(wc: WebContents): void {
    if (!wc || wc.isDestroyed()) return
    wireRenderGuest(wc)
  }

  /**
   * Attach (or reuse) the simulator wc's shared session via the broker. The
   * SAME wc is independently used by simulator-storage (DOMStorage capture) —
   * `broker.acquire` reuses its session rather than fighting it for exclusive
   * ownership, and our own switch-away/dispose only ever releases OUR lease
   * (see detachSimulator), never forces a physical detach that would kill
   * simulator-storage's capture too.
   */
  function attachSimulator(wc: WebContents): void {
    if (!wc || wc.isDestroyed()) return
    if (simWc === wc && !wc.isDestroyed()) return
    detachSimulator()

    const lease = broker.acquire(wc)
    if (!lease) {
      console.warn('[network-forward] debugger session unavailable; simulator network not captured')
      return
    }

    simWc = wc
    simLease = lease
    const attach = new SyncDisposableRegistry()
    attachDisposables = attach

    wireNetworkCapture(wc, 'service', attach, String(Date.now()))

    const detachSub = lease.onDetach(() => {
      if (simWc !== wc) return
      simWc = null
      simLease = null
      // Tear down OUR OWN wiring (wireNetworkCapture's 'message' listener) —
      // the broker already removed its own; without this, our listener would
      // keep receiving events from a session we no longer track as "current".
      const ad = attachDisposables
      attachDisposables = null
      if (ad) { try { ad.disposeAll() } catch { /* best-effort teardown */ } }
    })
    attach.add(() => detachSub.dispose())

    void lease.send('Network.enable').catch((err) => {
      console.warn('[network-forward] Network.enable failed:', err instanceof Error ? err.message : err)
    })
  }

  /**
   * Route a completed request to EXACTLY ONE sink, per the native-sink state
   * machine (no double-display):
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
    probeDeadline = null
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

    // A host swap while still 'probing' the OLD host must not inherit its
    // window: beginProbing()'s `sink === 'probing'` guard would otherwise skip
    // (re-)arming readyTimeoutTimer/probeDeadline for the NEW host, leaving it
    // probing forever with no timeout. Force through 'idle' so beginProbing()
    // always arms a fresh window for whichever host is now current.
    sink = 'idle'
    beginProbing()
    if (dispatchQueue.length > 0) scheduleFlush()
  }

  registry.add(() => { disposed = true })
  registry.add(() => {
    devtoolsHostDisposable?.dispose()
    devtoolsHostDisposable = null
    if (readyTimeoutTimer) { clearTimeout(readyTimeoutTimer); readyTimeoutTimer = null }
    if (readyRetryTimer) { clearTimeout(readyRetryTimer); readyRetryTimer = null }
  })
  registry.add(() => {
    bodyCache.clear()
    postDataCache.clear()
  })
  // Every debugger session (simulator + all render guests) must already be
  // detached and every 'message' listener already removed before `dispose()`
  // returns control to an un-awaited caller (every real call site is
  // `fwd.dispose()` with no `await`) — a guest event arriving in the SAME
  // tick as dispose() must never be forwarded. `registry` is a
  // SyncDisposableRegistry, so every entry below runs to completion before
  // disposeAll() returns — no ordering dependency between them.
  registry.add(() => detachSimulator())
  registry.add(() => {
    for (const wcId of [...guestWired.keys()]) cleanupGuest(wcId)
  })
  // Only detach sessions we self-attached if we own the broker's lifecycle —
  // a shared/injected broker keeps serving other consumers past our dispose().
  registry.add(() => {
    if (ownsBroker) broker.dispose()
  })

  return {
    attachSimulator,
    detachSimulator,
    attachRenderGuest,
    setDevtoolsHost: (wc) => applyDevtoolsHost(wc),
    // report() has no observing debugger, so there's no live CDP event to push
    // natively — surface it via the console fallback line.
    report: (record) => forwardToConsole(record),
    bodies: {
      getResponseBody: (requestId) => bodyCache.lookup(requestId),
      getRequestPostData: (requestId) => postDataCache.lookup(requestId),
    },
    dispose: () => registry.disposeAll(),
  }
}
