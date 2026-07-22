import { app, BrowserWindow, ipcMain, protocol, session as electronSession, webContents } from 'electron'
import type { IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { BRIDGE_CHANNELS as C, SIMULATOR_EVENTS as E, deviceInfoToHostEnv } from '../../shared/bridge-channels.js'
import type { NativeDeviceInfo, SyncStorageChange } from '../../shared/ipc-channels.js'
import { apiCallWatchdogMs, isPersistentSimulatorApi } from '../../shared/simulator-api-metadata.js'
import { devtoolsPackageRoot } from '../utils/paths.js'
import { createSessionListenerBag } from './session-listener-bag.js'
import type { SessionListenerBag } from './session-listener-bag.js'
import type {
  ActivePagePayload,
  ApiCallPayload,
  ApiResponsePayload,
  AppManifest,
  DisposePayload,
  HostEnvSnapshot,
  MessageEnvelope,
  NativeHostConfig,
  NavActionPayload,
  NavCallbackPayload,
  PageClosePayload,
  PageLifecyclePayload,
  PageOpenRequest,
  PageOpenResult,
  PageStackEntry,
  PageStackPayload,
  PageWindowConfig,
  RenderInvokePayload,
  RenderPublishPayload,
  ServiceInvokePayload,
  ServicePublishPayload,
  SpawnRequest,
  SpawnResult,
  TabActionPayload,
  TabBarConfig,
} from '../../shared/bridge-channels.js'
// eslint-disable-next-line no-restricted-syntax -- grandfathered(workbench-context): shrink-only
import type { WorkbenchContext } from '../services/workbench-context.js'
import type { ConnectionRegistry, DebugTap, Disposable } from '@dimina-kit/electron-deck/main'
import { createDebugTap } from '@dimina-kit/electron-deck/main'
import { startDiminaResourceServer, type DiminaResourceServer } from '../services/dimina-resource-server.js'
import {
  buildServiceHostSpawnUrl,
  createServiceHostWindow,
  navigateServiceHost,
  serviceHostSpec,
} from '../windows/service-host-window/create.js'
import { ServiceHostPool } from '../services/service-host-pool/pool.js'
import {
  registerMiniappSessionConfigurator,
  SHARED_MINIAPP_PARTITION,
} from '../services/views/miniapp-partition.js'
import { createConsoleForwarder, type GuestConsoleEntry } from '../services/console-forward/index.js'
import { createDiagnosticsBus } from '../services/diagnostics/index.js'
import { STORAGE_API_NAMES } from '../services/simulator-storage/index.js'
import { buildPageScrollScript } from './page-scroll.js'
import {
  createAppLifecycleController,
  type AppLifecycleController,
  type AppLifecycleEvent,
} from './app-lifecycle.js'

// The compiled `logic.js` ships a RELATIVE `//# sourceMappingURL=logic.js.map`.
// `injectLogicBundle` loads it via `executeJavaScript`, which gives the injected
// script no base URL of its own — so DevTools resolves that relative map against
// the service-host DOCUMENT and 404s, leaving console frames / Sources links
// pointing at the compiled bundle instead of the developer's source. This rewrite
// turns the directive absolute.
//
// Inlined (not imported from `service-host/sourcemap-rewrite.cjs`) ON PURPOSE:
// the shipped main entry is the FLAT esbuild bundle (`dist/main/index.bundle.js`,
// see electron-builder.yml `extraMetadata.main`). A runtime `createRequire(...)`
// of the relative `.cjs` resolved against `import.meta.url`, which is the bundle
// at `dist/main/` (one level shallower than the tsc tree `dist/main/ipc/`), so
// the path 404'd and the PACKAGED app crashed on load. Bundling the logic inline
// is bundler-proof. KEEP IN SYNC with `service-host/sourcemap-rewrite.cjs` (the
// copied-not-bundled service-host preload still requires that one).
function rewriteSourceMappingUrl(source: string, scriptUrl: string): string {
  if (typeof source !== 'string' || !source) return source
  const re = /(^|\n)[ \t]*\/\/[#@][ \t]*sourceMappingURL=([^\n]*)/g
  let lastIndex = -1
  let lastValue = ''
  let m: RegExpExecArray | null
  while ((m = re.exec(source)) !== null) {
    lastIndex = m.index + m[1].length
    lastValue = (m[2] || '').trim()
  }
  if (lastIndex < 0 || !lastValue) return source
  // Already absolute (scheme://, protocol-relative //host, or data:)? Leave it.
  if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(lastValue) || /^data:/i.test(lastValue)) return source
  let absolute: string
  try {
    absolute = new URL(lastValue, scriptUrl).toString()
  } catch {
    return source
  }
  return `${source.slice(0, lastIndex)}\n//# sourceMappingURL=${absolute}`
}

const STACK_ID = 'stack_0'

/**
 * Watchdog window a spawned session gets to reach `'running'` (root page
 * `domReady`) before `handleSpawn`'s launch timer reports `'launch-failed'`
 * with `code: 'timeout'`. Exported so tests can assert against the real
 * constant instead of a magic number.
 */
export const LAUNCH_TIMEOUT_MS = 20_000

/** Hard ceiling on the pre-warm pool, mirroring ServiceHostPool/prewarm-webview.md. */
const PREWARM_MAX_POOL_SIZE = 4

/**
 * Resolve the pre-warm pool size from env (see prewarm-webview.md's config
 * section). Returns 0 (OFF) unless
 * `DIMINA_PREWARM_POOL_SIZE` is a positive integer and `DIMINA_PREWARM_DISABLE`
 * is not set. Default OFF — pooling is opt-in so the spawn path is unchanged
 * unless explicitly enabled.
 */
function resolvePrewarmPoolSize(): number {
  if (process.env.DIMINA_PREWARM_DISABLE === '1') return 0
  const raw = process.env.DIMINA_PREWARM_POOL_SIZE
  if (!raw) return 0
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.min(n, PREWARM_MAX_POOL_SIZE)
}

/** debugTap (see foundation.md) is opt-in via `DIMINA_DEBUG_TAP=1` — off everywhere else. */
function resolveDebugTapEnabled(): boolean {
  return process.env.DIMINA_DEBUG_TAP === '1'
}

/**
 * Compact one-line summary of a bridge payload for debugTap — the inner
 * `msg.type` + `bridgeId`, never the full (potentially large) payload blob.
 */
function summarizeBridgeMsg(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const p = payload as Record<string, unknown>
  const bridgeId = typeof p.bridgeId === 'string' ? p.bridgeId : undefined
  const msg = p.msg as Record<string, unknown> | undefined
  const type = msg && typeof msg.type === 'string' ? msg.type : undefined
  const parts = [type, bridgeId ? `bridge=${bridgeId}` : undefined].filter(Boolean)
  return parts.length > 0 ? parts.join(' ') : undefined
}

interface RawAppConfig {
  app?: { window?: PageWindowConfig; tabBar?: TabBarConfig; entryPagePath?: string; pages?: string[] }
  modules?: Record<string, { window?: PageWindowConfig; root?: string } | undefined>
}

interface AppSession {
  appSessionId: string
  appId: string
  pkgRoot: string
  root: string
  scene: number
  serviceWindow: BrowserWindow
  serviceWc: WebContents
  simulatorWc: WebContents
  serviceLoaded: boolean
  /**
   * Outcome of `injectLogicBundle`: `null` while injection is in-flight (or not
   * yet attempted), `true` once the compiled `logic.js` executed in the service
   * host, `false` if it could not be fetched/injected. The compiled bundle is
   * the ONLY source of the service AND render module registry (`modDefine`), so
   * a `false` here means a downstream `loadResource → modRequire('app')` is
   * GUARANTEED to throw the cryptic `module app not found` (and render
   * `module <pagePath> not found`). Both `loadResource` sends gate on this so we
   * surface one actionable diagnostic instead of that misleading cascade.
   */
  logicInjected: boolean | null
  /**
   * Base URL every resource fetch (render bundles, service logic.js,
   * app-config.json, the dmb-resource protocol proxy) is resolved against.
   * Under the simulator path this is the dev server origin
   * (`http://localhost:<port>/`), which statically serves the compiled
   * `<appId>/<root>/…` tree. When a caller doesn't supply one (legacy / unit
   * tests), we fall back to a local `DiminaResourceServer` rooted at the
   * spawn's `pkgRoot/root` and use its baseUrl here.
   */
  resourceBaseUrl: string
  /** Local fallback server; null when `resourceBaseUrl` is an external (dev) server. */
  resourceServer: DiminaResourceServer | null
  hostEnv: HostEnvSnapshot
  appConfig: RawAppConfig
  manifest: AppManifest
  pages: Map<string, PageSession>
  /** Visible top-of-stack page bridgeId reported by DeviceShell (ACTIVE_PAGE).
   * Null until the first signal — callers fall back to the root bridgeId
   * (= appSessionId). Main has no z-order concept of its own; this mirrors the
   * DeviceShell ShellState so panels/automation can target the current page. */
  activeBridgeId: string | null
  /** Full ordered page stack (bottom→top) last reported by DeviceShell
   * (PAGE_STACK). Undefined until the first signal; automation's
   * `App.getPageStack` falls back to the single active page then. */
  pageStack?: PageStackEntry[]
  /** Pool entry id when the service window came from the pre-warm pool; null
   * for a fresh / fallback window (destroyed, not pooled, on dispose). */
  poolEntryId: string | null
  /** The pool-path `'did-finish-load'` boot listener, kept so dispose can detach
   * it before releasing the (recycled) window — otherwise a stale listener could
   * boot this disposed session into the next spawn's window. Null on the fresh
   * path (which uses a self-removing `once`). */
  onServiceBoot: (() => void) | null
  /** Session-scoped hooks on emitters that OUTLIVE this session — the shared
   * simulator WCV's `'destroyed'` and the service window's `'closed'` — are
   * registered through this bag so `disposeAppSession` detaches them all in
   * one place. A hook left behind on the shared simulator wc grows by one per
   * soft reload until the MaxListeners warning fires; a stale `'closed'` hook
   * on a pool-recycled window re-triggers this session's teardown. */
  listenerBag: SessionListenerBag
  /** Handle for this session's `ctx.registry` shutdown-fallback entry. Disposed
   * on normal session teardown so the registry doesn't grow one stale closure
   * per respawn (the fallback only needs to fire at whole-app shutdown for
   * sessions still live then). */
  registryHandle: Disposable | null
  /**
   * Whether this session has reached `'running'` (its root page reported
   * `domReady`). Gates the single 'launching' → 'running' transition — a
   * second `domReady` on the same session (e.g. a tab re-render) must not
   * re-fire the notification.
   */
  running: boolean
  /**
   * `LAUNCH_TIMEOUT_MS` watchdog armed at the end of `handleSpawn`. Cleared
   * the moment the session settles one way or another (running, launch
   * failure, crash, or disposal) so a stale timer can never fire a
   * 'launch-failed' after the session has already resolved — see
   * `clearLaunchTimer`.
   */
  launchTimer: NodeJS.Timeout | null
  /**
   * The start-page fallback applied at spawn (`resolveRootPagePath`), or null
   * when the requested page was mounted verbatim. A fact about the WHOLE
   * launch round, not any single phase: every runtime-status push carries it
   * (see `pushRuntimeStatus`), so a later phase change (e.g. 'running') cannot
   * silently drop it while the renderer's fallback banner is still showing it.
   */
  pageFallback: { requested: string; resolved: string } | null
}

interface PageSession {
  bridgeId: string
  appSessionId: string
  pagePath: string
  query: Record<string, unknown>
  isRoot: boolean
  isTab: boolean
  renderWc: WebContents | null
  renderLoaded: boolean
  resourceLoadedSent: boolean
  /**
   * The render guest reported `renderHostReady` while logic injection was still
   * in-flight (`ap.logicInjected === null`), so its render `loadResource` is
   * held: sending it before injection settles would race a failed bundle and
   * emit the cryptic `module <pagePath> not found`. `bootServiceHost` flushes
   * this on success and drops it on failure. The render guest fires
   * `renderHostReady` on its own `DOMContentLoaded`, which routinely beats the
   * async fetch+inject — without holding, the gate could only catch the rare
   * already-settled case.
   */
  renderLoadPending: boolean
  windowConfig: PageWindowConfig
}

type ProtocolHandler = (request: GlobalRequest) => Promise<Response>
type GlobalRequest = Parameters<typeof protocol.handle>[1] extends (request: infer T) => unknown ? T : Request

interface PendingApiCall {
  appSessionId: string
  callbacks: { success?: unknown; fail?: unknown; complete?: unknown }
  name: string
  /**
   * No-handler timeout. Cleared (and set to undefined) once a persistent
   * (`keep: true`) subscription produces its first fire, since such a call
   * stays pending until page/app teardown rather than timing out.
   */
  timer: NodeJS.Timeout | undefined
}

interface RouterState {
  appSessions: Map<string, AppSession>
  pageSessions: Map<string, PageSession>
  /** serviceWc → appSessionId. One hidden service-host window per session, so
   * this stays single-valued; a pooled window reused by a later session simply
   * rebinds its wc id. */
  serviceWcIdToAppSessionId: Map<number, string>
  /** simulatorWc → the app sessions it hosts, in spawn (insertion) order. One
   * simulator WCV owns SEVERAL live sessions at once (soft reload keeps the
   * outgoing session alive while the incoming one boots), so the binding is a
   * Set: membership authorizes the wc for any session it hosts, and insertion
   * order lets sender→session resolution pick the latest spawn. */
  simulatorWcIdToAppSessionIds: Map<number, Set<string>>
  /** renderWc → bridgeId. */
  wcIdToBridgeId: Map<number, string>
  /** requestId → pending API_CALL forwarded to a simulator window. */
  pendingApiCalls: Map<string, PendingApiCall>
  /** Pre-warm pool for service-host windows; null when pooling is disabled. */
  pool: ServiceHostPool | null
  /** Fan-out for render-side activity (domReady / active-page); set in install. */
  emitRenderEvent: (event: RenderEvent) => void
  /**
   * Per-webContents connection registry (see foundation.md). Render guests and
   * service-host windows are acquired here so their per-wc bookkeeping tears
   * down with the connection (destroy → close, pool reuse → reset) instead of
   * bespoke `once('destroyed')` listeners scattered through the router.
   */
  connections: ConnectionRegistry
  /**
   * Flag-gated ring buffer (see foundation.md) over the cross-wc bridge message
   * stream. Off by default (near-free no-op); when `DIMINA_DEBUG_TAP=1` it
   * records every SERVICE_INVOKE / RENDER_INVOKE / *_PUBLISH / API_RESPONSE at
   * the dispatch chokepoint (connection id + appSession + channel + direction)
   * so the cross-wc state machine is inspectable. This is debugTap's first real
   * consumer — the observability hangs on the LIVE runtime, not the
   * not-yet-integrated async envelope.
   */
  debugTap: DebugTap
  /**
   * App-level lifecycle listeners (wx.onAppShow / onAppHide / onError) keyed by
   * appSessionId. Fired on main-window foreground/background and service errors.
   */
  appLifecycle: AppLifecycleController
  /**
   * Evict the app's accumulated AppData bridges (panel registry) for every
   * page of the session. Lives on RouterState because `disposeAppSession` is
   * the single teardown chokepoint shared by BOTH dispose paths — graceful
   * `C.DISPOSE` and the simulator-WCV `'destroyed'` hook. Inlining eviction at
   * one call site (as the graceful handler once did) leaves the other path
   * with ghost AppData tabs after a respawn.
   */
  evictAppDataBridges: (ap: AppSession) => void
}

/** Default timeout for a simulator-forwarded API call. */

/**
 * Accessor over the bridge-router's private `RouterState`, stashed on
 * `ctx.bridge` so other main-process services (simulator-storage, automation,
 * appdata) can resolve live WebContents handles without owning router state.
 * All getters resolve fresh each call (the pre-warm pool can swap windows on
 * respawn, so cached handles go stale).
 */
/**
 * Render-side activity worth re-reading panel data on: a page's DOM mounted
 * (`domReady`), the visible page changed (`activePage`), or the active page's
 * DOM mutated in place (`domMutated`, from the render-guest MutationObserver).
 * Panels that pull from the active render guest (WXML/element-inspect) subscribe
 * via `BridgeRouterHandle.onRenderEvent` so they can refresh without polling.
 */
export interface RenderEvent {
  kind: 'domReady' | 'activePage' | 'domMutated'
  appId: string
  bridgeId: string
  /** activePage only: the now-visible page's route (bare pagePath), if known.
   * Lets the current-page panel push the route without a separate lookup. */
  pagePath?: string
}

/**
 * Point-in-time counts of every resource class RouterState owns. Leak coverage
 * (unit + e2e) asserts EXACT equality of this ledger around a churn cycle —
 * coarse memory sampling cannot see a leaked listener or a stale map entry, so
 * the owner of the bookkeeping reports precise counts instead.
 */
export interface BridgeResourceCensus {
  appSessions: number
  pageSessions: number
  serviceWcBindings: number
  /** Distinct live simulator webContents currently hosting ≥1 session. */
  simulatorWcs: number
  /** Total session memberships across all simulator wcs. */
  simulatorWcBindings: number
  renderWcBindings: number
  pendingApiCalls: number
  /**
   * `listenerCount('destroyed')` per unique live simulator wc (keyed by wc id).
   * One teardown hook per live session — a count above the hosted-session count
   * is the one-dead-listener-per-soft-reload leak class.
   */
  simulatorDestroyedListeners: Record<number, number>
}

export interface BridgeRouterHandle {
  /** Whether native-host mode is on (main is the source of truth). */
  isNativeHost(): boolean
  /** The render-host `<webview>` WebContents for a page bridgeId, or null. */
  resolveRenderWc(bridgeId: string): WebContents | null
  /** The hidden service-host window WebContents for the active (or named) app. */
  getServiceWc(appId?: string): WebContents | null
  /** The service-host window WebContents for the app that owns a page bridgeId,
   * or null. Lets render-side consumers (console forwarder) target the matching
   * app's service host even with multiple sessions open. */
  getServiceWcForBridge(bridgeId: string): WebContents | null
  /** The visible page's render WebContents for the active (or named) app. */
  getActiveRenderWc(appId?: string): WebContents | null
  /** The visible top-of-stack page bridgeId for the active (or named) app. */
  getActiveBridgeId(appId?: string): string | null
  /** The full ordered page stack (bottom→top) reported by DeviceShell, or null
   * before the first PAGE_STACK signal. Optional: only the native-host bridge
   * provides it (the default path derives the stack from the simulator URL). */
  getPageStack?(appId?: string): PageStackEntry[] | null
  /** The current (or named) app session's resource-server baseUrl (serves
   * that session's framework js/css), or null when no matching session
   * exists. Per-session, never a global singleton — see AppSession.resourceBaseUrl. */
  getResourceBaseUrl?(appId?: string): string | null
  /** Subscribe to render-side activity (domReady / active-page change). */
  onRenderEvent(listener: (event: RenderEvent) => void): () => void
  /** The currently-selected device (renderer toolbar), or null pre-selection. */
  getDevice(): NativeDeviceInfo | null
  /** Cache the selected device + push DEVICE_CHANGE to the live simulator WC(s). */
  setDevice(device: NativeDeviceInfo): void
  /**
   * Deterministically tear down every app session bound to the given simulator
   * WebContentsView id (project close / DeviceShell respawn). The session
   * mappings are cleared, the render-host guest webContents are closed, and the
   * service-host window is closed/released — synchronously, instead of waiting
   * on the WCV's async `'destroyed'` cascade — so the next project never
   * re-resolves or screenshots the outgoing project's render guest. Idempotent
   * with the `simulatorWc.once('destroyed')` hook (`disposeAppSession`
   * early-returns once a session is gone). Optional so partial test mocks of the
   * handle need not stub it.
   *
   * The synchronous prefix of the underlying disposeAppSession clears every map
   * + closes the render guests + the service window before it awaits, so the
   * bridge is clean the moment this is called. The returned promise resolves
   * after the async tail (pool.release / resourceServer.close) so the lifecycle
   * owner can sequence a reopen after full teardown. NOTE: disposeAppSession
   * catches and logs pool/resource-release failures internally, so the promise
   * resolves rather than rejecting on those — it is a completion signal, not an
   * error channel.
   */
  disposeSessionsForSimulator?(simulatorWcId: number): Promise<void>
  /**
   * The router's resource ledger (see BridgeResourceCensus). Optional so the
   * many partial BridgeRouterHandle test mocks don't each have to stub it.
   */
  census?(): BridgeResourceCensus
  /**
   * The flag-gated debugTap (see foundation.md) over the bridge message stream. Exposed so a
   * hidden devtools panel / automation can read `.entries()` when
   * `DIMINA_DEBUG_TAP=1`; a no-op snapshot otherwise. Optional so the many
   * partial `BridgeRouterHandle` test mocks don't each have to stub it.
   */
  debugTap?: DebugTap
}

// Same-appId matches prefer the MOST RECENT spawn (Maps preserve insertion
// order): after a respawn/reopen the newest session is the live one — the
// first match could be a just-superseded session mid-teardown. The loop must
// scan every session (no early break) so the LAST inserted match wins.
function findAppSessionByAppId(state: RouterState, appId: string): AppSession | undefined {
  let match: AppSession | undefined
  for (const ap of state.appSessions.values()) if (ap.appId === appId) match = ap
  return match
}

// No appId hint and no workspace session to disambiguate. Picking by appId is
// impossible, so fall back to the most-recent spawn — but ONLY when every live
// session belongs to the same app. Same-appId multiples are a respawn/reopen
// in progress where the newest is the live one (insertion order = spawn
// order). Multiple DISTINCT appIds mean a previous project is mid-teardown
// alongside the new one; any pick is a guess that can resolve the WRONG
// project's content (the screenshot/inspect-stale-app bug class), so prefer
// null over a wrong guess.
function resolveFallbackAppSession(state: RouterState): AppSession | undefined {
  let last: AppSession | undefined
  const distinctAppIds = new Set<string>()
  for (const ap of state.appSessions.values()) {
    last = ap
    distinctAppIds.add(ap.appId)
  }
  return distinctAppIds.size <= 1 ? last : undefined
}

/**
 * Resolve the "current" app session: prefer an explicit appId, else the
 * workspace's active project, else the only / most-recently-created session.
 * Native-host can host multiple AppSessions, so this picks one deterministically
 * rather than assuming a single session.
 */
function resolveCurrentApp(
  state: RouterState,
  ctx: WorkbenchContext,
  appId?: string,
): AppSession | undefined {
  if (appId) {
    const match = findAppSessionByAppId(state, appId)
    if (match) return match
  }
  const appInfo = ctx.workspace?.getSession?.()?.appInfo as { appId?: string } | undefined
  const activeAppId = appInfo?.appId
  if (activeAppId) {
    const match = findAppSessionByAppId(state, activeAppId)
    if (match) return match
  }
  // During a project close the workspace nulls its session BEFORE the bridge app
  // session is torn down (disposeSession runs before disposeAll). Resolving here
  // would hand a consumer the closing project's dying guest, so refuse to guess
  // while a close is in flight.
  if (ctx.workspace?.isClosing?.()) return undefined
  return resolveFallbackAppSession(state)
}

export function installBridgeRouter(ctx: WorkbenchContext): void {
  const state: RouterState = {
    appSessions: new Map(),
    pageSessions: new Map(),
    serviceWcIdToAppSessionId: new Map(),
    simulatorWcIdToAppSessionIds: new Map(),
    wcIdToBridgeId: new Map(),
    pendingApiCalls: new Map(),
    pool: null,
    emitRenderEvent: () => {},
    connections: ctx.connections,
    debugTap: createDebugTap({ enabled: resolveDebugTapEnabled() }),
    appLifecycle: createAppLifecycleController(),
    evictAppDataBridges: (ap) => {
      if (!ctx.appData) return
      for (const page of ap.pages.values()) ctx.appData.evictBridge(ap.appId, page.bridgeId)
    },
  }

  // Opt-in (default OFF) pre-warm pool for service-host windows. When enabled,
  // handleSpawn acquires a warm window instead of constructing one per spawn.
  const prewarmPoolSize = resolvePrewarmPoolSize()
  if (prewarmPoolSize > 0) {
    const pool = new ServiceHostPool()
    state.pool = pool
    // Defer warm-up off the cold-start critical path (see prewarm-webview.md:
    // app.ready + idle). Warming eagerly here races main-window startup — it creates an
    // extra hidden BrowserWindow before the workbench renderer has settled,
    // which made the e2e's first-window/preload-readiness flaky. The timer is
    // cancelled on teardown so it can't warm a disposed pool.
    const warmTimer = setTimeout(() => {
      void pool
        .init({ defaultPoolSize: prewarmPoolSize, defaultSpec: serviceHostSpec(), maxPoolSize: PREWARM_MAX_POOL_SIZE })
        .catch((error) => {
          console.warn('[bridge-router] webview pool warm-up failed:', error)
        })
    }, 500)
    ctx.registry.add(() => clearTimeout(warmTimer))
    ctx.registry.add(() => state.pool?.dispose())
  }

  installAppLifecycleDriver(ctx, state)

  installResourceProtocolHandlers(ctx, state)

  // The currently-selected device (renderer toolbar). Cached here so it can ride
  // the NATIVE_HOST_ENABLED reply (race-free DeviceShell init) and so the
  // safe-area service can read it when a render-host guest attaches.
  let currentDevice: NativeDeviceInfo | null = null

  // Native-host enablement query. The simulator webview's preload can't read the
  // launch `process.env` (and additionalArguments don't reach webview guests),
  // nor can it compute file paths (no node:path/url in the guest preload), so it
  // asks main synchronously at install time for the flag + the render-host URLs.
  const onNativeHostQuery = (event: IpcMainEvent): void => {
    // native-host is the sole runtime: always reply enabled with the render-host
    // file:// URLs the simulator preload needs. `device` rides along so the
    // DeviceShell mounts with the right bezel size synchronously (the renderer
    // pushes SetDeviceInfo before AttachNative, so the cache is populated by the
    // time the simulator preload runs this sendSync).
    const reply: NativeHostConfig = {
      enabled: true,
      renderHostHtmlUrl: pathToFileURL(path.join(devtoolsPackageRoot, 'dist/render-host/pageFrame.html')).toString(),
      renderPreloadUrl: pathToFileURL(path.join(devtoolsPackageRoot, 'dist/render-host/preload.cjs')).toString(),
      device: currentDevice ?? undefined,
    }
    event.returnValue = reply
  }
  ipcMain.on(C.NATIVE_HOST_ENABLED, onNativeHostQuery)
  ctx.registry.add(() => { ipcMain.removeListener(C.NATIVE_HOST_ENABLED, onNativeHostQuery) })

  // Subscribers to render-side activity (domReady / active-page). Panels that
  // pull from the active render guest (WXML) re-read on these.
  const renderEventListeners = new Set<(event: RenderEvent) => void>()
  const emitRenderEvent = (event: RenderEvent): void => {
    for (const listener of renderEventListeners) {
      try { listener(event) } catch (error) {
        console.warn('[bridge-router] render-event listener threw:', error)
      }
    }
  }
  state.emitRenderEvent = emitRenderEvent

  // Expose a thin accessor over RouterState so other main services (storage,
  // automation, appdata) can resolve live render/service WebContents without
  // owning router state. Getters resolve fresh — the pre-warm pool can swap
  // windows on respawn, so cached handles go stale.
  const bridgeHandle: BridgeRouterHandle = {
    isNativeHost: () => true,
    resolveRenderWc: (bridgeId) => {
      const page = state.pageSessions.get(bridgeId)
      return page?.renderWc && !page.renderWc.isDestroyed() ? page.renderWc : null
    },
    getServiceWc: (appId) => {
      const ap = resolveCurrentApp(state, ctx, appId)
      return ap && !ap.serviceWc.isDestroyed() ? ap.serviceWc : null
    },
    getServiceWcForBridge: (bridgeId) => {
      const page = state.pageSessions.get(bridgeId)
      if (!page) return null
      const ap = state.appSessions.get(page.appSessionId)
      return ap && !ap.serviceWc.isDestroyed() ? ap.serviceWc : null
    },
    getActiveBridgeId: (appId) => {
      const ap = resolveCurrentApp(state, ctx, appId)
      if (!ap) return null
      // Fall back to the root page (= appSessionId) before the first signal.
      return ap.activeBridgeId ?? ap.appSessionId
    },
    getPageStack: (appId) => {
      const ap = resolveCurrentApp(state, ctx, appId)
      return ap?.pageStack ?? null
    },
    getResourceBaseUrl: (appId) => {
      const ap = resolveCurrentApp(state, ctx, appId)
      return ap?.resourceBaseUrl ?? null
    },
    getActiveRenderWc: (appId) => {
      const ap = resolveCurrentApp(state, ctx, appId)
      if (!ap) return null
      const page = state.pageSessions.get(ap.activeBridgeId ?? ap.appSessionId)
      return page?.renderWc && !page.renderWc.isDestroyed() ? page.renderWc : null
    },
    onRenderEvent: (listener) => {
      renderEventListeners.add(listener)
      return () => renderEventListeners.delete(listener)
    },
    getDevice: () => currentDevice,
    setDevice: (device) => {
      currentDevice = device
      // Push to the live simulator WC(s) so a mounted DeviceShell re-renders the
      // bezel/status-bar/notch. Pre-spawn there is no session yet — the initial
      // device rides NATIVE_HOST_ENABLED instead. Dedupe across app sessions
      // that share one simulator WCV.
      const seen = new Set<number>()
      for (const ap of state.appSessions.values()) {
        const wc = ap.simulatorWc
        if (wc && !wc.isDestroyed() && !seen.has(wc.id)) {
          seen.add(wc.id)
          wc.send(E.DEVICE_CHANGE, device)
        }
      }
    },
    disposeSessionsForSimulator: (simulatorWcId) => {
      // Snapshot ids first: disposeAppSession mutates state.appSessions.
      const ids: string[] = []
      for (const [id, ap] of state.appSessions) {
        if (ap.simulatorWc.id === simulatorWcId) ids.push(id)
      }
      // disposeAppSession's synchronous prefix clears every map + closes the
      // render guests + the service window, so the bridge is clean the moment
      // this is called. The joined promise resolves after the async tail
      // (pool.release / resourceServer.close) so a caller can sequence a reopen
      // after full teardown. disposeAppSession logs those tail failures
      // internally, so this resolves rather than rejecting on them — it is a
      // completion signal, not an error channel.
      return Promise.all(ids.map((id) => disposeAppSession(state, id))).then(() => {})
    },
    debugTap: state.debugTap,
    census: (): BridgeResourceCensus => {
      const simulatorDestroyedListeners: Record<number, number> = {}
      let simulatorWcBindings = 0
      for (const ids of state.simulatorWcIdToAppSessionIds.values()) simulatorWcBindings += ids.size
      for (const ap of state.appSessions.values()) {
        const wc = ap.simulatorWc
        if (!wc.isDestroyed() && simulatorDestroyedListeners[wc.id] === undefined) {
          simulatorDestroyedListeners[wc.id] = wc.listenerCount('destroyed')
        }
      }
      return {
        appSessions: state.appSessions.size,
        pageSessions: state.pageSessions.size,
        serviceWcBindings: state.serviceWcIdToAppSessionId.size,
        simulatorWcs: state.simulatorWcIdToAppSessionIds.size,
        simulatorWcBindings,
        renderWcBindings: state.wcIdToBridgeId.size,
        pendingApiCalls: state.pendingApiCalls.size,
        simulatorDestroyedListeners,
      }
    },
  }
  ctx.bridge = bridgeHandle

  // e2e resource-census probe: Playwright's electronApp.evaluate() reads the
  // router's ledger straight off this main-process global — no IPC surface
  // needed. Test builds only.
  if (process.env.NODE_ENV === 'test') {
    ;(globalThis as Record<string, unknown>).__diminaResourceCensus = () => bridgeHandle.census?.()
  }

  // Always-on guest console fan-out. Owns `ctx.guestConsole` (the sink the
  // consoleLog case below routes to) so that render-layer console output is
  // mirrored into the service host's own console — surfacing it in the embedded
  // Chrome DevTools (attached to the service host) prefixed `[视图]` — regardless
  // of whether an automation client is connected. Automation now SUBSCRIBES to
  // this forwarder instead of clobbering `ctx.guestConsole`.
  // Authoritative diagnostics bus (see workbench-context.ts): the single place
  // main-synthesized diagnostics are born. The forwarder subscribes to it so
  // every diagnostic also lands in the owning session's embedded DevTools
  // Console panel, not just the main-process log / automation subscribers.
  // A caller (host embedding, or a test) may have already installed one on
  // `ctx` before `installBridgeRouter` runs — respect it instead of
  // clobbering it with a fresh bus; only a bus WE create here is ours to
  // dispose on teardown.
  const ownsDiagnosticsBus = ctx.diagnostics === undefined
  const diagnosticsBus = ctx.diagnostics ?? createDiagnosticsBus()
  ctx.diagnostics = diagnosticsBus
  const consoleForwarder = createConsoleForwarder(bridgeHandle, diagnosticsBus)
  ctx.consoleForwarder = consoleForwarder
  ctx.guestConsole = consoleForwarder
  ctx.registry.add(() => {
    void consoleForwarder.dispose()
    ctx.consoleForwarder = undefined
    ctx.guestConsole = undefined
    if (ownsDiagnosticsBus) {
      diagnosticsBus.dispose()
      ctx.diagnostics = undefined
    }
  })

  // DeviceShell → main: record the visible top-of-stack page bridgeId so the
  // accessor above can resolve "the active page". Sender-validated against the
  // app that owns it; ignored for unknown apps/pages.
  const onActivePage = (event: IpcMainEvent, payload: ActivePagePayload): void => {
    const ap = state.appSessions.get(payload.appSessionId)
    if (!ap) return
    if (!senderBoundToSession(state, event.sender, ap)) return
    if (ap.pages.has(payload.bridgeId)) {
      ap.activeBridgeId = payload.bridgeId
      const pagePath = state.pageSessions.get(payload.bridgeId)?.pagePath
      emitRenderEvent({ kind: 'activePage', appId: ap.appId, bridgeId: payload.bridgeId, pagePath })
    }
  }
  ipcMain.on(C.ACTIVE_PAGE, onActivePage)
  ctx.registry.add(() => { ipcMain.removeListener(C.ACTIVE_PAGE, onActivePage) })

  // DeviceShell → main: the full ordered page stack (bottom→top). Stored so
  // automation's App.getPageStack can report a multi-page stack (main has no
  // stack of its own). Sender-validated against the owning app.
  const onPageStack = (event: IpcMainEvent, payload: PageStackPayload): void => {
    const ap = state.appSessions.get(payload.appSessionId)
    if (!ap) return
    if (!senderBoundToSession(state, event.sender, ap)) return
    ap.pageStack = payload.stack
  }
  ipcMain.on(C.PAGE_STACK, onPageStack)
  ctx.registry.add(() => { ipcMain.removeListener(C.PAGE_STACK, onPageStack) })

  ipcMain.handle(C.SPAWN, async (event, opts: SpawnRequest): Promise<SpawnResult> => {
    return handleSpawn(state, ctx, event, opts)
  })
  ctx.registry.add(() => { ipcMain.removeHandler(C.SPAWN) })

  ipcMain.handle(C.PAGE_OPEN, async (event, opts: PageOpenRequest): Promise<PageOpenResult> => {
    return handlePageOpen(state, event, opts)
  })
  ctx.registry.add(() => { ipcMain.removeHandler(C.PAGE_OPEN) })

  const onPageClose = (event: IpcMainEvent, payload: PageClosePayload): void => {
    handlePageClose(state, event.sender, payload)
  }
  ipcMain.on(C.PAGE_CLOSE, onPageClose)
  ctx.registry.add(() => { ipcMain.removeListener(C.PAGE_CLOSE, onPageClose) })

  const onPageLifecycle = (event: IpcMainEvent, payload: PageLifecyclePayload): void => {
    handlePageLifecycle(state, event.sender, payload)
    // Native-host AppData: evict the bridge on page teardown so the panel drops
    // its tab (mirrors the default path's postMessage(pageUnload) eviction).
    if (payload.event === 'pageUnload' && ctx.appData) {
      const ap = state.appSessions.get(payload.appSessionId)
      if (ap && senderBoundToSession(state, event.sender, ap)) {
        ctx.appData.evictBridge(ap.appId, payload.bridgeId)
      }
    }
  }
  ipcMain.on(C.PAGE_LIFECYCLE, onPageLifecycle)
  ctx.registry.add(() => { ipcMain.removeListener(C.PAGE_LIFECYCLE, onPageLifecycle) })

  const onNavCallback = (event: IpcMainEvent, payload: NavCallbackPayload): void => {
    handleNavCallback(state, event.sender, payload)
  }
  ipcMain.on(C.NAV_CALLBACK, onNavCallback)
  ctx.registry.add(() => { ipcMain.removeListener(C.NAV_CALLBACK, onNavCallback) })

  const onDispose = (event: IpcMainEvent, payload: DisposePayload): void => {
    const target = resolveAppByBridgeId(state, payload.bridgeId)
    if (!target) return
    // Only the app's service window or simulator window can issue dispose.
    // (Unknown senders pass — lenient by design; a simulator WCV is authorized
    // for every session it hosts, so an older session's own dispose stays
    // valid while a newer spawn shares the wc.)
    if (!senderBoundToSession(state, event.sender, target) && appByWc(state, event.sender)) {
      console.warn(`[bridge-router] DISPOSE rejected: sender not bound to target ${target.appSessionId}`)
      return
    }
    // AppData bridge eviction happens inside disposeAppSession (single
    // chokepoint shared with the simulator-WCV 'destroyed' path).
    void disposeAppSession(state, target.appSessionId)
  }
  ipcMain.on(C.DISPOSE, onDispose)
  ctx.registry.add(() => { ipcMain.removeListener(C.DISPOSE, onDispose) })

  // debugTap (see foundation.md) ingress recorder — near-free no-op unless DIMINA_DEBUG_TAP=1.
  // Hung on the bridge dispatch chokepoint so the cross-wc message flow is
  // inspectable (the first real consumer of the workbench debugTap primitive).
  const tapIn = (channel: string, sender: WebContents, payload: unknown): void => {
    if (!state.debugTap.enabled) return
    state.debugTap.record({
      ts: Date.now(),
      channel,
      direction: 'in',
      connectionId: sender.id,
      appSessionId: appByWc(state, sender)?.appSessionId,
      summary: summarizeBridgeMsg(payload),
    })
  }

  const onServiceInvoke = (event: IpcMainEvent, payload: ServiceInvokePayload): void => {
    tapIn(C.SERVICE_INVOKE, event.sender, payload)
    const ap = appByWc(state, event.sender)
    if (!ap) return
    const page = state.pageSessions.get(payload.bridgeId) ?? state.pageSessions.get(ap.appSessionId)
    if (!page) return
    routeFromService(state, ap, page, payload.msg, ctx)
  }
  ipcMain.on(C.SERVICE_INVOKE, onServiceInvoke)
  ctx.registry.add(() => { ipcMain.removeListener(C.SERVICE_INVOKE, onServiceInvoke) })

  const onServicePublish = (event: IpcMainEvent, payload: ServicePublishPayload): void => {
    tapIn(C.SERVICE_PUBLISH, event.sender, payload)
    const ap = appByWc(state, event.sender)
    if (!ap) return
    forwardToRender(ap, payload.msg, payload.targetBridgeId)
    // Native-host AppData panel: tap the service→render setData stream centrally
    // (the simulator guest has no Worker to sniff under native-host). Cheap —
    // the tap ignores non-ub/non-page_* messages.
    ctx.appData?.onServiceToRender(ap.appId, payload.msg)
  }
  ipcMain.on(C.SERVICE_PUBLISH, onServicePublish)
  ctx.registry.add(() => { ipcMain.removeListener(C.SERVICE_PUBLISH, onServicePublish) })

  const onRenderInvoke = (event: IpcMainEvent, payload: RenderInvokePayload): void => {
    tapIn(C.RENDER_INVOKE, event.sender, payload)
    const page = ensureRenderBound(state, event.sender, payload.bridgeId)
    if (!page) return
    const ap = state.appSessions.get(page.appSessionId)
    if (!ap) return
    routeFromRender(state, ap, page, payload.msg, ctx)
  }
  ipcMain.on(C.RENDER_INVOKE, onRenderInvoke)
  ctx.registry.add(() => { ipcMain.removeListener(C.RENDER_INVOKE, onRenderInvoke) })

  const onRenderPublish = (event: IpcMainEvent, payload: RenderPublishPayload): void => {
    tapIn(C.RENDER_PUBLISH, event.sender, payload)
    const page = ensureRenderBound(state, event.sender, payload.bridgeId)
    if (!page) return
    const ap = state.appSessions.get(page.appSessionId)
    if (!ap) return
    forwardToService(ap, payload.msg)
  }
  ipcMain.on(C.RENDER_PUBLISH, onRenderPublish)
  ctx.registry.add(() => { ipcMain.removeListener(C.RENDER_PUBLISH, onRenderPublish) })

  ipcMain.handle(C.SIMULATOR_API, async (_event, payload: { name: string; params: unknown }) => {
    return ctx.simulatorApis.invoke(payload.name, payload.params)
  })
  ctx.registry.add(() => { ipcMain.removeHandler(C.SIMULATOR_API) })

  const onApiResponse = (event: IpcMainEvent, payload: ApiResponsePayload): void => {
    tapIn(C.API_RESPONSE, event.sender, payload)
    handleApiResponse(state, event.sender, payload)
  }
  ipcMain.on(C.API_RESPONSE, onApiResponse)
  ctx.registry.add(() => { ipcMain.removeListener(C.API_RESPONSE, onApiResponse) })

  ctx.registry.add(async () => {
    // Clear any in-flight pending API timers before tearing down sessions so a
    // late simulator response cannot fire a callback against a torn-down app.
    for (const pending of state.pendingApiCalls.values()) clearTimeout(pending.timer)
    state.pendingApiCalls.clear()
  })

  ctx.registry.add(async () => {
    await Promise.all(
      Array.from(state.appSessions.keys()).map(id => disposeAppSession(state, id)),
    )
  })
}

// ── Spawn / Open / Close ─────────────────────────────────────────────────────

/** Clear a session's launch-timeout watchdog, if still armed. Idempotent. */
function clearLaunchTimer(ap: AppSession): void {
  if (ap.launchTimer === null) return
  clearTimeout(ap.launchTimer)
  ap.launchTimer = null
}

/**
 * Arm the `LAUNCH_TIMEOUT_MS` watchdog for a freshly spawned session. Fires
 * `'launch-failed'` (`code: 'timeout'`) exactly once, and only if the session
 * is both still registered (not disposed) and has not already reached
 * `'running'` — both settle paths clear the timer themselves, but a timer
 * queued just before either lands could still fire on the old macrotask queue.
 */
function startLaunchTimer(state: RouterState, ctx: WorkbenchContext, ap: AppSession): void {
  ap.launchTimer = setTimeout(() => {
    ap.launchTimer = null
    if (ap.running) return
    if (state.appSessions.get(ap.appSessionId) !== ap) return
    const reason = `Service host did not report readiness within ${LAUNCH_TIMEOUT_MS}ms`
    ctx.diagnostics?.report({
      severity: 'error',
      code: 'launch-timeout',
      message: reason,
      appSessionId: ap.appSessionId,
    })
    pushRuntimeStatus(ctx, ap, { phase: 'launch-failed', code: 'timeout', reason })
  }, LAUNCH_TIMEOUT_MS)
}

/**
 * Flip a session to `'running'` on its root page's first `domReady` — the
 * single source-of-truth transition out of `'launching'`. Guarded by
 * `ap.running` so a later re-render of the same root page (or any non-root
 * page) never re-fires the notification or re-clears an already-cleared timer.
 */
function markSessionRunning(ctx: WorkbenchContext, ap: AppSession, page: PageSession): void {
  if (!page.isRoot || ap.running) return
  ap.running = true
  clearLaunchTimer(ap)
  pushRuntimeStatus(ctx, ap, { phase: 'running' })
}

/**
 * The single chokepoint for session runtime-status pushes. Every event
 * carries the session's launch-round facts (appId + pageFallback) alongside
 * the phase change — the renderer replaces its runtimeStatus wholesale, so an
 * event that omitted a still-true fallback would silently blank the fallback
 * banner the moment the phase advances past 'launching'.
 */
function pushRuntimeStatus(
  ctx: WorkbenchContext,
  session: Pick<AppSession, 'appId' | 'pageFallback'>,
  status: { phase: 'launching' | 'running' | 'launch-failed' | 'crashed'; code?: string; reason?: string },
): void {
  ctx.notify?.sessionRuntimeStatus?.({
    appId: session.appId,
    ...status,
    ...(session.pageFallback ? { pageFallback: session.pageFallback } : {}),
  })
}

async function handleSpawn(
  state: RouterState,
  ctx: WorkbenchContext,
  event: IpcMainInvokeEvent,
  opts: SpawnRequest,
): Promise<SpawnResult> {
  const appId = opts.appId
  if (!appId) throw new Error('[bridge-router] spawn requires appId')
  const bridgeId = opts.bridgeId || newBridgeId()
  const appSessionId = bridgeId

  const simulatorWc = resolveSimulatorWebContents(ctx, opts.simulatorWcId, event.sender)
  const pagePath = normalizePagePath(opts.pagePath || 'pages/index/index')
  const workspaceProjectPath = typeof ctx.workspace.getProjectPath === 'function'
    ? ctx.workspace.getProjectPath()
    : ''
  const pkgRoot = path.resolve(opts.pkgRoot || workspaceProjectPath || process.cwd())
  const root = opts.root || 'main'
  // Host-config custom API namespaces (WorkbenchContext is the single owner).
  // Threaded into the service-host spawn URL so its preload can install the
  // namespace globals; the simulator-supplied `opts.apiNamespaces` is derived
  // from the same host config and is not authoritative here.
  const apiNamespaces = ctx.apiNamespaces ?? []

  // Resource base resolution. Preferred: the simulator-supplied dev-server
  // origin, which statically serves the compiled `<appId>/<root>/…` tree (same
  // source the default dimina-fe `<webview>` reads). Fallback (no dev server —
  // legacy/unit tests): a local server rooted at `pkgRoot/root`. Either way
  // `resourceBaseUrl` is the single base all fetches resolve against.
  let resourceServer: DiminaResourceServer | null = null
  let resourceBaseUrl: string
  if (opts.resourceBaseUrl) {
    resourceBaseUrl = opts.resourceBaseUrl.endsWith('/') ? opts.resourceBaseUrl : `${opts.resourceBaseUrl}/`
  } else {
    resourceServer = await startDiminaResourceServer(path.resolve(pkgRoot, root))
    resourceBaseUrl = resourceServer.baseUrl
  }
  // The selected device (renderer toolbar) is the authoritative source for the
  // logical dims a spawn must report. The simulator-supplied `hostEnvSnapshot`
  // is derived from the device baked into the simulator at BOOT time, so on a
  // RESPAWN after a live device change it still carries the boot device. Layer
  // the live `currentDevice` on top so every spawn/respawn reports the selected
  // device — matching what the live `SetDeviceInfo` HostEnvUpdate pushes to an
  // already-running service host. Pre-selection (null) → simulator snapshot wins.
  const selectedDevice = ctx.bridge?.getDevice?.() ?? null
  const hostEnv = makeHostEnv({
    ...opts.hostEnvSnapshot,
    ...(selectedDevice ? deviceInfoToHostEnv(selectedDevice) : {}),
  })

  // app-config.json lives at `<base><appId>/<root>/app-config.json` on the dev
  // server, or at the local server root for the fallback path.
  const appConfig = await loadAppConfig(
    resourceServer ? resourceServer.baseUrl : `${resourceBaseUrl}${appId}/${root}/`,
    ({ url, error }) => {
      ctx.diagnostics?.report({
        severity: 'error',
        code: 'app-config-unreachable',
        message: `app-config.json unreachable at ${url}: ${String(error)}`,
        appSessionId,
      })
    },
  )
  const manifest = buildAppManifest(appConfig, pagePath)
  const { resolvedPagePath, pageFallbackApplied } = resolveRootPagePath(manifest, pagePath)
  if (pageFallbackApplied) {
    reportPageNotFound(ctx, appSessionId, pagePath, resolvedPagePath)
  }
  const rootWindowConfig = resolvePageWindowConfig(appConfig, resolvedPagePath)
  const isTab = isTabPage(appConfig, resolvedPagePath)

  // Acquire a pre-warmed service-host window when pooling is enabled; otherwise
  // construct one fresh (default). A pooled/fallback window is warmed on
  // about:blank and must be navigated to the spawn URL below; the fresh path
  // navigates inside createServiceHostWindow.
  const usedPool = state.pool !== null
  let poolEntryId: string | null = null
  let serviceWindow: BrowserWindow
  // Shared spawn-navigation failure handler (fresh AND pooled paths): without
  // it a loadURL rejection is fully swallowed — did-finish-load never fires and
  // the only signal is the launch watchdog's late timeout instead of the cause.
  const reportServiceHostNavigationFailed = (spawnUrl: string, err: unknown): void => {
    const message = `Failed to navigate service host to ${spawnUrl}: ${String(err)}`
    ctx.diagnostics?.report({
      severity: 'error',
      code: 'service-host-navigation-failed',
      message,
      appSessionId,
    })
    // The session registers after window construction; resolve it fresh so the
    // fresh-path callback (created pre-registration) still clears the watchdog.
    const ap = state.appSessions.get(appSessionId)
    if (ap) clearLaunchTimer(ap)
    pushRuntimeStatus(
      ctx,
      ap ?? { appId, pageFallback: pageFallbackApplied ? { requested: pagePath, resolved: resolvedPagePath } : null },
      { phase: 'launch-failed', code: 'service-host-navigation-failed', reason: message },
    )
  }
  if (state.pool) {
    const acquired = await state.pool.acquire(serviceHostSpec())
    serviceWindow = acquired.win
    poolEntryId = acquired.entryId
  } else {
    const freshWindowOptions = {
      bridgeId,
      appId,
      // Same (appId, projectPath) pair the simulator WCV uses, so this project's
      // service host and render guests land on ONE partition while a different
      // project with the same appId is isolated. Use the path captured at spawn
      // ENTRY (workspaceProjectPath), not a re-read: a project switch during the
      // awaits above would otherwise give the service host a different path than
      // the simulator WCV was built with, splitting the partition.
      projectPath: workspaceProjectPath || undefined,
      pagePath: resolvedPagePath,
      pkgRoot,
      root,
      resourceBaseUrl,
      hostEnvSnapshot: hostEnv,
      apiNamespaces,
    }
    serviceWindow = createServiceHostWindow({
      ...freshWindowOptions,
      onLoadFailed: err => reportServiceHostNavigationFailed(buildServiceHostSpawnUrl(freshWindowOptions), err),
    })
  }

  const appSession: AppSession = {
    appSessionId,
    appId,
    pkgRoot,
    root,
    scene: opts.scene ?? 1001,
    serviceWindow,
    serviceWc: serviceWindow.webContents,
    simulatorWc,
    serviceLoaded: false,
    logicInjected: null,
    resourceBaseUrl,
    resourceServer,
    hostEnv,
    appConfig,
    manifest,
    pages: new Map(),
    activeBridgeId: null,
    poolEntryId,
    onServiceBoot: null,
    listenerBag: createSessionListenerBag(),
    registryHandle: null,
    running: false,
    launchTimer: null,
    pageFallback: pageFallbackApplied ? { requested: pagePath, resolved: resolvedPagePath } : null,
  }

  const rootPage: PageSession = {
    bridgeId,
    appSessionId,
    pagePath: resolvedPagePath,
    query: opts.query ?? {},
    isRoot: true,
    isTab,
    renderWc: null,
    renderLoaded: false,
    resourceLoadedSent: false,
    renderLoadPending: false,
    windowConfig: rootWindowConfig,
  }

  state.appSessions.set(appSessionId, appSession)
  state.pageSessions.set(bridgeId, rootPage)
  appSession.pages.set(bridgeId, rootPage)
  bindWc(state.serviceWcIdToAppSessionId, serviceWindow.webContents, appSessionId)
  bindSimulatorWc(state.simulatorWcIdToAppSessionIds, simulatorWc, appSessionId)
  // Track the service-host webContents as a Connection (the soft-reuse
  // teardown path documented in foundation.md) and
  // own this session's serviceWc→appSessionId binding on its CURRENT lifetime
  // segment. On a pooled-window REUSE, `disposeAppSession` calls
  // `connections.reset(serviceWc.id)` → this owned cleanup fires + a fresh
  // segment opens, so the next session rebinding the same wc starts clean; on a
  // real destroy the connection closes and fires it too. The cleanup is guarded
  // by `appSessionId` so it only clears a binding that is still THIS session's.
  // (The simulatorWc binding stays manual in `disposeAppSession`: the simulator
  // wc outlives individual app sessions — cross-connection state documented in
  // foundation.md — so it
  // cannot hang off any single session's segment.)
  state.connections.acquire(serviceWindow.webContents).own(() => {
    if (state.serviceWcIdToAppSessionId.get(appSession.serviceWc.id) === appSessionId) {
      state.serviceWcIdToAppSessionId.delete(appSession.serviceWc.id)
    }
  })
  appSession.registryHandle = ctx.registry.add(() => disposeAppSession(state, appSessionId))

  const onServiceClosed = (): void => {
    void disposeAppSession(state, appSessionId, { serviceAlreadyClosed: true })
  }
  appSession.listenerBag.once(serviceWindow, 'closed', onServiceClosed)

  // The simulator WCV owns the app's UI lifetime. When it is destroyed —
  // project close (`views.disposeAll`/detach) or a DeviceShell respawn
  // (`attachNativeSimulator`, e.g. watcher hot reload) — the guest never gets
  // to send its graceful `C.DISPOSE`, so without this hook the app session and
  // its hidden service-host window leak, and `resolveCurrentApp` keeps
  // resolving the STALE session for the same appId: `getActiveRenderWc` then
  // dereferences dead pages and every panel pull (WXML/elements) returns null
  // for the whole next session. Disposing here is idempotent with the graceful
  // path (`disposeAppSession` early-returns once the session is gone).
  const onSimulatorDestroyed = (): void => {
    void disposeAppSession(state, appSessionId)
  }
  appSession.listenerBag.once(simulatorWc, 'destroyed', onSimulatorDestroyed)
  // The simulator WCV may have been torn down DURING this spawn's awaits
  // (loadAppConfig / resource server / service-host creation) — e.g. a project
  // close/switch that ran while we were mid-flight. In that case its 'destroyed'
  // event already fired and the once() above will never run, so the freshly
  // registered session would be a zombie owned by a dead simulator (the
  // teardown's disposeSessionsForSimulator snapshot taken before appSessions.set
  // could not have included it). Dispose now — idempotent with the graceful
  // path — so a closed/superseded simulator can't leave a resurrected session.
  if (simulatorWc.isDestroyed()) {
    void disposeAppSession(state, appSessionId)
  }

  if (usedPool) {
    // A pooled/fallback window passes through about:blank (warm load or the
    // fallback's initial load). Boot only once the REAL service.html navigation
    // finishes — filtering by URL so an about:blank did-finish-load can't fire a
    // premature boot. The listener removes itself after the first match.
    const bootOnServiceLoad = (): void => {
      if (serviceWindow.isDestroyed()) return
      // This session was disposed before its service.html settled: self-evict so
      // a recycled window doesn't carry a stale listener into the next spawn.
      if (state.appSessions.get(appSessionId) !== appSession) {
        serviceWindow.webContents.removeListener('did-finish-load', bootOnServiceLoad)
        return
      }
      // Ignore the warm/about:blank load; only the real service.html boots.
      if (!serviceWindow.webContents.getURL().includes('service.html')) return
      serviceWindow.webContents.removeListener('did-finish-load', bootOnServiceLoad)
      void bootServiceHost(state, appSession, ctx)
    }
    appSession.onServiceBoot = bootOnServiceLoad
    serviceWindow.webContents.on('did-finish-load', bootOnServiceLoad)
    const spawnUrl = buildServiceHostSpawnUrl({
      bridgeId,
      appId,
      pagePath: resolvedPagePath,
      pkgRoot,
      root,
      resourceBaseUrl,
      hostEnvSnapshot: hostEnv,
      apiNamespaces,
    })
    void navigateServiceHost(serviceWindow, spawnUrl, {
      onLoadFailed: err => reportServiceHostNavigationFailed(spawnUrl, err),
    })
  } else {
    // Fresh window: its only navigation is service.html (issued inside
    // createServiceHostWindow), so the first did-finish-load is the spawn load.
    serviceWindow.webContents.once('did-finish-load', () => {
      void bootServiceHost(state, appSession, ctx)
    })
  }

  // Service-host crash (renderer process gone): a session-scoped hook on the
  // service webContents, bound via the listener bag so `disposeAppSession`
  // detaches it (matching the 'closed'/'destroyed' hooks registered above).
  // Not a `.once` — a pooled service window can recover and crash again
  // across its lifetime, and each crash is independently worth surfacing.
  // Fires whether the crash lands before or after 'running'; only the launch
  // timer needs clearing (it may already be null) since a running session no
  // longer has one armed.
  const onServiceCrashed = (): void => {
    clearLaunchTimer(appSession)
    ctx.diagnostics?.report({
      severity: 'error',
      code: 'service-host-crashed',
      message: `Service host renderer process gone for appSessionId=${appSessionId}`,
      appSessionId,
    })
    pushRuntimeStatus(ctx, appSession, { phase: 'crashed', code: 'service-host-crashed' })
  }
  appSession.listenerBag.on(serviceWindow.webContents, 'render-process-gone', onServiceCrashed)

  pushRuntimeStatus(ctx, appSession, { phase: 'launching' })
  startLaunchTimer(state, ctx, appSession)

  return {
    appSessionId,
    bridgeId,
    pagePath,
    resolvedPagePath,
    pageFallbackApplied,
    serviceWcId: serviceWindow.webContents.id,
    resourceBaseUrl,
    manifest,
    rootWindowConfig,
  }
}

async function handlePageOpen(
  state: RouterState,
  event: IpcMainInvokeEvent,
  opts: PageOpenRequest,
): Promise<PageOpenResult> {
  const ap = state.appSessions.get(opts.appSessionId)
  if (!ap) throw new Error(`[bridge-router] PAGE_OPEN unknown appSession ${opts.appSessionId}`)
  // Only the simulator window owning the app can open additional pages.
  if (!senderBoundToSession(state, event.sender, ap)) {
    throw new Error('[bridge-router] PAGE_OPEN rejected: caller not bound to app session')
  }

  const pagePath = normalizePagePath(opts.pagePath)
  // Defense-in-depth against a page absent from the compiled manifest: the
  // nav gate (handleNavActionApi) already blocks normal navigateTo/switchTab
  // traffic upstream, but PAGE_OPEN is reachable directly (any IPC caller), so
  // this refuses to register a PageSession main can never load resources for.
  // Only enforced against a real compiled manifest ('app-config') — a
  // 'fallback' manifest has no compiled truth to validate membership against.
  if (ap.manifest.source === 'app-config' && !ap.manifest.pages.includes(pagePath)) {
    throw new Error(`[bridge-router] PAGE_OPEN rejected: page-not-found "${pagePath}" is not in the compiled manifest`)
  }
  const bridgeId = opts.bridgeId || newBridgeId()
  const windowConfig = resolvePageWindowConfig(ap.appConfig, pagePath)
  const isTab = isTabPage(ap.appConfig, pagePath)

  const page: PageSession = {
    bridgeId,
    appSessionId: opts.appSessionId,
    pagePath,
    query: opts.query ?? {},
    isRoot: false,
    isTab,
    renderWc: null,
    renderLoaded: false,
    resourceLoadedSent: false,
    renderLoadPending: false,
    windowConfig,
  }
  state.pageSessions.set(bridgeId, page)
  ap.pages.set(bridgeId, page)

  return { bridgeId, pagePath, windowConfig, isTab }
}

function handlePageClose(state: RouterState, sender: WebContents, payload: PageClosePayload): void {
  const page = state.pageSessions.get(payload.bridgeId)
  if (!page) return
  if (page.isRoot) {
    console.warn('[bridge-router] PAGE_CLOSE refused on root page; use DISPOSE')
    return
  }
  const ap = state.appSessions.get(page.appSessionId)
  if (!ap) return
  if (!senderBoundToSession(state, sender, ap)) {
    console.warn('[bridge-router] PAGE_CLOSE rejected: caller not bound to app session')
    return
  }
  disposePageSession(state, ap, page)
}

function handlePageLifecycle(state: RouterState, sender: WebContents, payload: PageLifecyclePayload): void {
  const ap = state.appSessions.get(payload.appSessionId)
  if (!ap) return
  if (!senderBoundToSession(state, sender, ap)) return

  forwardToService(ap, {
    type: payload.event,
    target: 'service',
    body: { bridgeId: payload.bridgeId },
  })
}

function handleNavCallback(state: RouterState, sender: WebContents, payload: NavCallbackPayload): void {
  const ap = state.appSessions.get(payload.appSessionId)
  if (!ap) return
  if (!senderBoundToSession(state, sender, ap)) return

  const result = { errMsg: payload.errMsg }
  if (payload.ok) {
    sendCallback(ap, payload.callbacks.success, result)
  } else {
    sendCallback(ap, payload.callbacks.fail, result)
  }
  sendCallback(ap, payload.callbacks.complete, result)
}

// ── Service-host boot & per-page resource handshake ──────────────────────────

async function bootServiceHost(state: RouterState, ap: AppSession, ctx: WorkbenchContext): Promise<void> {
  // Liveness guard: never boot a session that was already disposed. With pooling,
  // the service window is recycled, so a stale did-finish-load listener from an
  // early-disposed prior owner could otherwise fire here and inject the wrong
  // app's logic.js into the next spawn (the recycled webContents is shared).
  if (state.appSessions.get(ap.appSessionId) !== ap) return
  // The service wc just did-finish-load'd (that's how this got invoked) — flush
  // any diagnostic queued for this session (or the global bucket) into its now
  // resolvable console. Safe to call even when nothing is queued.
  ctx.consoleForwarder?.notifyServiceHostReady?.(ap.appSessionId)
  ap.logicInjected = await injectLogicBundle(ap)
  if (!ap.logicInjected) {
    // The compiled logic.js never executed, so `modDefine` registered nothing.
    // Sending `loadResource` now would run `modRequire('app')` against an empty
    // registry and throw the cryptic `module app not found` — masking the real
    // cause (unreachable resource tree / failed compile / unresolved appId).
    // Skip it and surface one actionable diagnostic instead; the render side
    // gates on the same flag in `routeFromRender`.
    const reason = reportLogicLoadFailure(ap, ctx)
    clearLaunchTimer(ap)
    pushRuntimeStatus(ctx, ap, { phase: 'launch-failed', code: 'logic-bundle-unreachable', reason })
    return
  }
  // A root page absent from the compiled manifest — most commonly a page the
  // developer deleted, then hot-reloaded to — is not registered in logic.js.
  // BOTH the service runtime AND the render runtime eager-`modRequire(pagePath)`
  // it and throw `module <pagePath> not found`, which aborts the launch and
  // leaves the simulator permanently blank. Gate BOTH sends and surface a
  // WeChat-style diagnostic instead: the shell stays alive (an empty phone frame
  // + a clear Console error) rather than a silent dead blank. Choosing a valid
  // fallback page belongs at the renderer reload source (it owns the pagePath
  // the render guest is spawned with); here we only refuse a load guaranteed to
  // throw, so main and render never disagree about which page is live.
  const rootPage = ap.pages.get(ap.appSessionId)
  const rootMissing = !!rootPage && !pageInManifest(ap, rootPage.pagePath)
  if (rootMissing) {
    reportPageNotFound(ctx, ap.appSessionId, rootPage.pagePath)
  } else if (rootPage) {
    // serviceLoaded is flipped only when service responds with
    // `serviceResourceLoaded`; see handleContainerMsg. Setting it here would
    // race a per-page `resourceLoaded` ahead of the service-side handler.
    forwardToService(ap, makeLoadResource(ap, rootPage, 'service'))
  }
  // Flush any render `loadResource` that arrived (renderHostReady) while
  // injection was in-flight — now that the bundle is confirmed present.
  // `sendRenderLoadResource` refuses a page absent from the manifest, so a
  // missing root never reaches the throwing render `modRequire`.
  for (const page of ap.pages.values()) {
    if (!page.renderLoadPending) continue
    page.renderLoadPending = false
    sendRenderLoadResource(ap, page)
  }
}

function sendRenderLoadResource(ap: AppSession, page: PageSession): void {
  if (!page.renderWc || page.renderWc.isDestroyed()) return
  // Single choke point for BOTH the boot flush above and the late
  // `renderHostReady` direct-send in `routeFromRender`: never send a render load
  // for a page absent from the compiled manifest. The render runtime
  // eager-`modRequire`s the pagePath and would throw `module <pagePath> not
  // found`, blanking the simulator (a page the developer deleted, then
  // hot-reloaded to). bootServiceHost surfaces the one-shot diagnostic.
  if (!pageInManifest(ap, page.pagePath)) return
  page.renderWc.send(C.TO_RENDER, { msg: makeLoadResource(ap, page, 'render') })
}

/** The compiled logic.js URL `injectLogicBundle` fetches (mode-dependent). */
function logicBundleUrl(ap: AppSession): string {
  return ap.resourceServer
    ? new URL('logic.js', ap.resourceBaseUrl).toString()
    : new URL(`${ap.appId}/${ap.root}/logic.js`, ap.resourceBaseUrl).toString()
}

async function injectLogicBundle(ap: AppSession): Promise<boolean> {
  // Fetch the compiled service logic over HTTP from the same base the render
  // host reads (`<base><appId>/<root>/logic.js`). The fallback local server
  // serves its root, so `<base>logic.js` resolves there too — both are http.
  const logicUrl = logicBundleUrl(ap)
  try {
    const res = await fetch(logicUrl)
    if (!res.ok) throw new Error(`logic.js fetch ${res.status} at ${logicUrl}`)
    // Rewrite the relative `sourceMappingURL` to an absolute dev-server URL
    // BEFORE injecting — `executeJavaScript` gives the script no base URL, so a
    // relative map would 404 and break sourcemapped console frames / Sources.
    const logicContent = rewriteSourceMappingUrl(await res.text(), logicUrl)
    await ap.serviceWc.executeJavaScript(`${logicContent}\n//# sourceURL=${logicUrl}`, true)
    return true
  } catch (error) {
    console.warn('[bridge-router] unable to inject service logic.js:', error)
    return false
  }
}

/**
 * Emit one actionable diagnostic when the compiled logic bundle could not be
 * loaded — the single point where "the app's compiled resource tree is
 * unreachable" is known with certainty. Reported through `ctx.diagnostics`,
 * which mirrors it to the main-process log AND — via `consoleForwarder`'s
 * subscription — injects it into the service host's own console, so it
 * actually surfaces in the embedded DevTools Console panel where the
 * developer would otherwise see only the misleading `module app not found`.
 * `guestConsole.emit` is kept alongside for the automation `App.logAdded`
 * subscriber, which does not consume the diagnostics bus.
 *
 * Returns the short (pre-hint) form of the message so `bootServiceHost` can
 * reuse it verbatim as the `sessionRuntimeStatus` `reason` instead of
 * duplicating the wording.
 */
function reportLogicLoadFailure(ap: AppSession, ctx: WorkbenchContext): string {
  const hint = ap.appId === 'unknown'
    ? ' appId could not be resolved (it fell back to "unknown") — the mini-program likely failed to compile or its project manifest/app config is missing.'
    : ''
  const shortReason = `[dimina-kit] Failed to load the mini-program logic bundle from ${logicBundleUrl(ap)}.`
  const message
    = `${shortReason} `
    + 'The service runtime has no registered modules, so no page can mount.'
    + hint
    + ` Verify the project compiled successfully and that the resource server serves "${ap.appId}/${ap.root}/".`
  ctx.diagnostics?.report({
    severity: 'error',
    code: 'logic-bundle-unreachable',
    message,
    appSessionId: ap.appSessionId,
  })
  ctx.guestConsole?.emit({ source: 'service', level: 'error', args: [message] })
  return shortReason
}

/** Whether `pagePath` still exists in the app's freshly compiled manifest. */
function pageInManifest(ap: AppSession, pagePath: string): boolean {
  // A 'fallback' manifest (app-config.json unreachable) holds only the spawn
  // request — no compiled truth to check membership against. Every mount gate
  // keyed on manifest membership must agree: the nav/PAGE_OPEN front gates
  // already let a fallback manifest through, so this back gate (render
  // loadResource) must too, or a page they admitted silently never loads.
  if (ap.manifest.source !== 'app-config') return true
  return ap.manifest.pages.includes(normalizePagePath(pagePath))
}

/**
 * WeChat-devtools-style "page does not exist" diagnostic. Reported through
 * `ctx.diagnostics` (main log + injected into the embedded Console panel via
 * `consoleForwarder`) when a mount targets a pagePath that is not in the
 * compiled manifest — most commonly a page the developer deleted, then
 * hot-reloaded. `guestConsole.emit` is kept alongside for the automation
 * subscriber.
 */
function reportPageNotFound(
  ctx: WorkbenchContext,
  appSessionId: string,
  pagePath: string,
  fallbackTo?: string,
): void {
  const base
    = `Page[${pagePath}] not found. May be caused by: 1. Forgetting to add page route in app.json. `
    + '2. Invoking Page() in async task.'
  const message = fallbackTo ? `${base} Falling back to "${fallbackTo}".` : base
  ctx.diagnostics?.report({
    severity: 'error',
    code: 'page-not-found',
    message,
    appSessionId,
  })
  ctx.guestConsole?.emit({ source: 'service', level: 'error', args: [message] })
}

function maybeSendResourceLoaded(ap: AppSession, page: PageSession): void {
  if (page.resourceLoadedSent || !ap.serviceLoaded || !page.renderLoaded) return
  page.resourceLoadedSent = true
  // Non-root pages (navigateTo / redirectTo / reLaunch / non-cached switchTab)
  // were never sent a SERVICE-side loadResource — only the root gets one at
  // bootServiceHost. Without it the service never `modRequire`s the page module,
  // so `getModuleByPath` misses and `createInstance` no-ops: the page mounts on
  // the render side but its service instance — and thus its AppData / WXML /
  // `Page.getData` — never exist. Mirror the render side, which sends
  // loadResource per page on `renderHostReady`. `loadResource` only registers
  // the module definition (no firstRender), and same-channel FIFO ordering
  // guarantees the module is registered before the `resourceLoaded` below runs
  // `createInstance`. Safety invariants 1-4 reviewed in
  // docs/native-host-abstractions.md.
  if (!page.isRoot) {
    forwardToService(ap, makeLoadResource(ap, page, 'service'))
  }
  forwardToService(ap, {
    type: 'resourceLoaded',
    target: 'service',
    body: {
      bridgeId: page.bridgeId,
      scene: ap.scene,
      pagePath: page.pagePath,
      query: page.query,
      stackId: STACK_ID,
    },
  })
}

// ── Message routing ──────────────────────────────────────────────────────────

function routeFromService(
  state: RouterState,
  ap: AppSession,
  defaultPage: PageSession,
  msg: MessageEnvelope,
  ctx: WorkbenchContext,
): void {
  if (msg.type === 'serviceResourceLoaded') {
    handleContainerMsg(ap, defaultPage, msg, ctx, state)
    return
  }
  if (msg.target === 'render') {
    forwardToRender(ap, msg)
    return
  }
  if (msg.target === 'container') {
    const page = pageFromMsg(state, ap, msg) ?? defaultPage
    handleContainerMsg(ap, page, msg, ctx, state)
  }
}

function routeFromRender(
  state: RouterState,
  ap: AppSession,
  page: PageSession,
  msg: MessageEnvelope,
  ctx: WorkbenchContext,
): void {
  if (msg.type === 'renderHostReady') {
    // Logic injection definitively failed: the render bundle shares the same
    // (unreachable) resource tree, so `loadResource` here would only produce a
    // second cryptic `module <pagePath> not found`. bootServiceHost already
    // surfaced the actionable diagnostic — stay silent.
    if (ap.logicInjected === false) return
    // Injection still in-flight: the render guest fires `renderHostReady` on its
    // own DOMContentLoaded, which routinely beats the async fetch+inject. Hold
    // the render `loadResource` and let `bootServiceHost` flush it once the
    // bundle settles, so a failed bundle never reaches the render side.
    if (ap.logicInjected === null) {
      page.renderLoadPending = true
      return
    }
    sendRenderLoadResource(ap, page)
    return
  }

  if (msg.type === 'renderResourceLoaded') {
    handleContainerMsg(ap, page, msg, ctx, state)
    return
  }

  if (msg.target === 'service') {
    forwardToService(ap, msg)
    return
  }
  if (msg.target === 'container') {
    handleContainerMsg(ap, page, msg, ctx, state)
  }
}

/**
 * Report 'service-uncaught-error' for a consoleLog(source:'service') body —
 * the service preload's uncaught error/unhandledrejection post. CDP's
 * `Runtime.consoleAPICalled` (services/service-console) never observes these
 * (they never call `console.*`), so this diagnostics report is the only way
 * one reaches the Console panel / main log.
 */
function reportServiceUncaughtError(ctx: WorkbenchContext, ap: AppSession, body: GuestConsoleEntry): void {
  const severity = body.level === 'error' ? 'error' : body.level === 'warn' ? 'warn' : 'info'
  const message = Array.isArray(body.args) ? body.args.map(a => String(a)).join(' ') : String(body.args ?? '')
  ctx.diagnostics?.report({ severity, code: 'service-uncaught-error', message, appSessionId: ap.appSessionId })
}

function handleContainerMsg(
  ap: AppSession,
  page: PageSession,
  msg: MessageEnvelope,
  ctx: WorkbenchContext,
  state: RouterState,
): void {
  switch (msg.type) {
    case 'serviceResourceLoaded':
      ap.serviceLoaded = true
      for (const p of ap.pages.values()) maybeSendResourceLoaded(ap, p)
      break
    case 'renderResourceLoaded': {
      const target = readBridgeId(msg)
      const p = (target && ap.pages.get(target)) || page
      p.renderLoaded = true
      maybeSendResourceLoaded(ap, p)
      break
    }
    case 'domReady':
      if (!ap.simulatorWc.isDestroyed()) {
        ap.simulatorWc.send(E.DOM_READY, { bridgeId: page.bridgeId })
      }
      state.emitRenderEvent({ kind: 'domReady', appId: ap.appId, bridgeId: page.bridgeId })
      markSessionRunning(ctx, ap, page)
      break
    case 'invokeAPI':
      void handleSimulatorApi(state, ap, page, msg.body, ctx)
      break
    case 'serviceHostError': {
      // Forward the error to every registered `wx.onError` listener. (The dimina
      // service runtime's App lifecycle is only onLaunch/onShow/onHide, so it
      // does not dispatch `App.onError` — `wx.onError` is the supported path.)
      // The service preload's `deliver` try/catch already reports errors thrown
      // during lifecycle/event dispatch here.
      const errBody = msg.body as { message?: unknown } | undefined
      const errArg = errBody?.message ?? msg.body
      // Reported through the diagnostics bus (main log + Console-panel
      // injection); `ctx.diagnostics.report` replaces the bare `console.warn`
      // this case used to make directly.
      ctx.diagnostics?.report({
        severity: 'error',
        code: 'service-host-error',
        message: String(errArg),
        appSessionId: ap.appSessionId,
      })
      for (const id of state.appLifecycle.listeners(ap.appSessionId, 'onError')) {
        sendCallback(ap, id, errArg)
      }
      break
    }
    case 'consoleLog': {
      // Native-host console capture: the render-host / service-host guest preloads
      // monkeypatch console.* and post each entry here (one case handles both —
      // distinguish via msg.body.source). Forward to the console sink (set by the
      // automation server under native-host) so it can rebroadcast as App.logAdded.
      // Guarded + non-throwing: console capture must never break message routing.
      ctx.guestConsole?.emit(msg.body)
      const body = msg.body as GuestConsoleEntry | undefined
      if (body?.source === 'service') reportServiceUncaughtError(ctx, ap, body)
      break
    }
    case 'storageChanged':
      // Native-host SYNC storage liveness: the service-host's `setStorageSync`/etc.
      // write `localStorage` directly (no main round-trip), so they post the change
      // here for the Storage panel to stay live. Trust `ap.appId` (sender-resolved),
      // not any appId in the body. Guarded + non-throwing.
      ctx.onServiceStorageChanged?.(ap.appId, msg.body as SyncStorageChange)
      break
    case 'wxmlChanged':
      // Native-host WXML liveness: the render-guest MutationObserver posts this when
      // the active page's DOM mutated in place (setData). Surface it as a render
      // event so the WXML panel service re-pulls + pushes — same pipeline as
      // domReady/activePage. Trust `page.bridgeId` (sender-resolved), not the body.
      state.emitRenderEvent({ kind: 'domMutated', appId: ap.appId, bridgeId: page.bridgeId })
      break
    default:
      break
  }
}

// ── Simulator-window-resident APIs ──────────────────────────────────────────

const NAV_BAR_API_NAMES = new Set([
  'setNavigationBarTitle',
  'setNavigationBarColor',
  'showNavigationBarLoading',
  'hideNavigationBarLoading',
  'hideHomeButton',
])

const NAV_ACTION_NAMES = new Set([
  'navigateTo',
  'navigateBack',
  'redirectTo',
  'reLaunch',
  'switchTab',
])

const TAB_ACTION_NAMES = new Set([
  'setTabBarStyle',
  'setTabBarItem',
  'showTabBar',
  'hideTabBar',
  'setTabBarBadge',
  'removeTabBarBadge',
  'showTabBarRedDot',
  'hideTabBarRedDot',
])

/**
 * Drive app foreground/background from the main window's visibility. Minimizing
 * or hiding the window backgrounds the mini-program (App.onHide + wx.onAppHide);
 * restoring or showing it foregrounds it (App.onShow + wx.onAppShow). Focus/blur
 * is deliberately NOT used — clicking a DevTools panel would falsely fire it.
 * The initial App.onShow fires once at spawn (service `invokeSomeLifecycle`), so
 * the driver only handles subsequent transitions.
 */
function installAppLifecycleDriver(ctx: WorkbenchContext, state: RouterState): void {
  const win = ctx.windows?.mainWindow
  // Guard against a headless/stub mainWindow (unit tests) that isn't a real
  // event-emitting BrowserWindow.
  if (!win || typeof win.on !== 'function') return

  const emit = (serviceEvent: 'appShow' | 'appHide', listenerEvent: AppLifecycleEvent): void => {
    for (const ap of state.appSessions.values()) {
      // App.onShow / onHide: the service runtime already listens for these.
      forwardToService(ap, { type: serviceEvent, target: 'service', body: {} })
      // wx.onAppShow / onAppHide imperative listeners.
      for (const id of state.appLifecycle.listeners(ap.appSessionId, listenerEvent)) {
        sendCallback(ap, id, {})
      }
    }
  }

  const onHide = (): void => emit('appHide', 'onAppHide')
  const onShow = (): void => emit('appShow', 'onAppShow')
  win.on('hide', onHide)
  win.on('minimize', onHide)
  win.on('show', onShow)
  win.on('restore', onShow)
  ctx.registry.add(() => {
    win.off('hide', onHide)
    win.off('minimize', onHide)
    win.off('show', onShow)
    win.off('restore', onShow)
  })
}

// wx app-event API name → the lifecycle event whose listeners it (de)registers.
const APP_LIFECYCLE_REGISTER: Record<string, AppLifecycleEvent> = {
  onAppShow: 'onAppShow',
  onAppHide: 'onAppHide',
  onError: 'onError',
}
const APP_LIFECYCLE_UNREGISTER: Record<string, AppLifecycleEvent> = {
  offAppShow: 'onAppShow',
  offAppHide: 'onAppHide',
  offError: 'onError',
}

function handleNavBarApi(ap: AppSession, page: PageSession, name: string, params: Record<string, unknown>): void {
  if (!ap.simulatorWc.isDestroyed()) {
    ap.simulatorWc.send(E.NAV_BAR, {
      bridgeId: page.bridgeId,
      name,
      params,
    })
  }
  const successResult = { errMsg: `${name}:ok` }
  sendCallback(ap, params.success, successResult)
  sendCallback(ap, params.complete, successResult)
}

// Fails a nav/tab action's service-side callback through the same success/
// complete dispatch every other API branch uses — the one mechanism for
// answering a call that never reaches (or never should reach) the simulator.
function failActionCallback(ap: AppSession, params: Record<string, unknown>, errMsg: string): void {
  const fail = { errMsg }
  sendCallback(ap, params.fail, fail)
  sendCallback(ap, params.complete, fail)
}

// Shared by handleNavActionApi/handleTabActionApi: both forward a same-shaped
// payload to the simulator window, differing only in the event name and the
// payload's static `name` union. Simulator-destroyed fails the callback
// directly since there is no ack path to fail through otherwise.
function sendActionOrFail(
  ap: AppSession,
  eventName: string,
  payload: NavActionPayload | TabActionPayload,
  name: string,
  params: Record<string, unknown>,
): void {
  if (!ap.simulatorWc.isDestroyed()) {
    ap.simulatorWc.send(eventName, payload)
    return
  }
  failActionCallback(ap, params, `${name}:fail simulator window destroyed`)
}

/** The bare page path a nav/tab action targets (query-stripped, normalized), or undefined for an action carrying none (navigateBack). */
function extractNavTargetPagePath(params: Record<string, unknown>): string | undefined {
  const raw = params.url
  if (typeof raw !== 'string' || !raw) return undefined
  return normalizePagePath(raw.split('?')[0] ?? raw)
}

interface NavTargetVerdict {
  ok: boolean
  errMsg?: string
  /** Whether the failure is a genuine "page not found" (worth a diagnostic), vs. e.g. switchTab's "not a tabBar page" (the page exists, just isn't tab-able). */
  reportNotFound?: boolean
}

/**
 * Whether a nav/tab action's target page is mountable — checked ONLY against
 * a real compiled manifest (`source === 'app-config'`); a `'fallback'`
 * manifest can't tell mountable from not, so it lets everything through.
 */
function checkNavTarget(ap: AppSession, name: string, targetPagePath: string): NavTargetVerdict {
  if (ap.manifest.source !== 'app-config') return { ok: true }
  if (!ap.manifest.pages.includes(targetPagePath)) {
    return { ok: false, errMsg: `${name}:fail page "${targetPagePath}" is not found`, reportNotFound: true }
  }
  if (name === 'switchTab') {
    const inTabBar = ap.manifest.tabBar?.list.some(item => normalizePagePath(item.pagePath) === targetPagePath) ?? false
    if (!inTabBar) return { ok: false, errMsg: 'switchTab:fail can not switch to no-tabBar page' }
  }
  return { ok: true }
}

function handleNavActionApi(
  ap: AppSession,
  ctx: WorkbenchContext,
  page: PageSession,
  name: string,
  params: Record<string, unknown>,
): void {
  const targetPagePath = extractNavTargetPagePath(params)
  if (targetPagePath !== undefined) {
    const verdict = checkNavTarget(ap, name, targetPagePath)
    if (!verdict.ok) {
      if (verdict.reportNotFound) reportPageNotFound(ctx, ap.appSessionId, targetPagePath)
      failActionCallback(ap, params, verdict.errMsg!)
      return
    }
  }
  const payload: NavActionPayload = {
    appSessionId: ap.appSessionId,
    bridgeId: page.bridgeId,
    name: name as NavActionPayload['name'],
    params,
    callbacks: extractCallbacks(params),
  }
  sendActionOrFail(ap, E.NAV_ACTION, payload, name, params)
}

function handleTabActionApi(ap: AppSession, page: PageSession, name: string, params: Record<string, unknown>): void {
  const payload: TabActionPayload = {
    appSessionId: ap.appSessionId,
    bridgeId: page.bridgeId,
    name: name as TabActionPayload['name'],
    params,
    callbacks: extractCallbacks(params),
  }
  sendActionOrFail(ap, E.TAB_ACTION, payload, name, params)
}

// App-level lifecycle listeners (wx.onAppShow / onAppHide / onError + off*).
// The service encodes the listener as a keep callback id in `params.success`;
// we store it and re-fire on main-window foreground/background (the driver in
// installBridgeRouter) and on serviceHostError. `off*` clears the event's
// listeners for the session. Returns true when `name` matched a lifecycle
// register/unregister call (fully handled), false to fall through.
function handleAppLifecycleToggle(
  state: RouterState,
  ap: AppSession,
  name: string,
  params: Record<string, unknown>,
): boolean {
  const lifecycleRegister = APP_LIFECYCLE_REGISTER[name]
  if (lifecycleRegister) {
    state.appLifecycle.register(ap.appSessionId, lifecycleRegister, params.success)
    return true
  }
  const lifecycleUnregister = APP_LIFECYCLE_UNREGISTER[name]
  if (lifecycleUnregister) {
    // off(cb) carries the same evtId as the original on(cb) → removes just that
    // listener; off() with no callback carries no id → clears the whole event.
    state.appLifecycle.unregister(ap.appSessionId, lifecycleUnregister, params.success)
    return true
  }
  return false
}

// pageScrollTo acts on the page's render guest (scroll its document), which
// only the main process can reach — run the scroll script in the invoking
// page's render webContents rather than forwarding to the simulator.
function handlePageScrollApi(ap: AppSession, page: PageSession, params: Record<string, unknown>): void {
  const renderWc = page.renderWc
  if (renderWc && !renderWc.isDestroyed()) {
    void renderWc.executeJavaScript(buildPageScrollScript(params)).catch(() => {})
  }
  const successResult = { errMsg: 'pageScrollTo:ok' }
  sendCallback(ap, params.success, successResult)
  sendCallback(ap, params.complete, successResult)
}

// Shared try/invoke/callback pattern used by the storageApi and
// ctx.simulatorApis branches: relay the resolved value through
// success+complete, or the thrown error through fail+complete with a
// namespaced errMsg.
async function invokeSimulatorApiAndCallback(
  ap: AppSession,
  name: string,
  params: Record<string, unknown>,
  invoke: () => Promise<unknown>,
): Promise<void> {
  try {
    const result = await invoke()
    sendCallback(ap, params.success, result)
    sendCallback(ap, params.complete, result)
  } catch (error) {
    const failResult = { errMsg: `${name}:fail ${error instanceof Error ? error.message : String(error)}` }
    sendCallback(ap, params.fail, failResult)
    sendCallback(ap, params.complete, failResult)
  }
}

async function handleSimulatorApi(
  state: RouterState,
  ap: AppSession,
  page: PageSession,
  body: Record<string, unknown>,
  ctx: WorkbenchContext,
): Promise<void> {
  const name = String(body.name ?? '')
  const params = normalizeParams(body.params)

  if (NAV_BAR_API_NAMES.has(name)) {
    handleNavBarApi(ap, page, name, params)
    return
  }

  if (NAV_ACTION_NAMES.has(name)) {
    handleNavActionApi(ap, ctx, page, name, params)
    return
  }

  if (TAB_ACTION_NAMES.has(name)) {
    handleTabActionApi(ap, page, name, params)
    return
  }

  if (handleAppLifecycleToggle(state, ap, name, params)) return

  if (name === 'pageScrollTo') {
    handlePageScrollApi(ap, page, params)
    return
  }

  // Native-host storage unification: route async wx.setStorage/getStorage/etc.
  // to the service-host window's file:// store (the same store the *Sync APIs +
  // the Storage panel use), instead of forwarding to the simulator guest's
  // http:// origin. Without this, async writes and sync writes diverge across
  // two origins even for the running mini-app.
  if (ctx.storageApi && STORAGE_API_NAMES.has(name)) {
    const storageApi = ctx.storageApi
    await invokeSimulatorApiAndCallback(ap, name, params, () => storageApi.invoke(ap.appId, name, params))
    return
  }

  // Main-process registry (downstream-registered host APIs via
  // instance.registerSimulatorApi). If the name is not registered here, fall
  // through to the simulator-window forwarding branch — the simulator-resident
  // MiniApp owns the DOM-touching defaults (wx.getSystemInfo, chooseImage,
  // chooseMedia, fs.*, …) and the bridge-router can't run those itself.
  if (ctx.simulatorApis.has(name)) {
    await invokeSimulatorApiAndCallback(ap, name, params, () => ctx.simulatorApis.invoke(name, params))
    return
  }

  forwardApiCallToSimulator(state, ap, page, name, params)
}

function forwardApiCallToSimulator(
  state: RouterState,
  ap: AppSession,
  page: PageSession,
  name: string,
  params: Record<string, unknown>,
): void {
  const callbacks = extractCallbacks(params)
  if (ap.simulatorWc.isDestroyed()) {
    const fail = { errMsg: `${name}:fail simulator window destroyed` }
    sendCallback(ap, callbacks.fail, fail)
    sendCallback(ap, callbacks.complete, fail)
    return
  }

  const requestId = newRequestId()
  // Persistent subscriptions (`keep: true`, e.g. audioListen) bind their event
  // bridge synchronously but only emit their FIRST response when the first
  // event fires (which can be well past the no-handler window). Arming the
  // one-shot timeout would tear the subscription down before it ever delivers,
  // so keep calls run without a timeout and are reaped on page/app teardown.
  // Recognise persistent subscriptions BY NAME (`audioListen`) too: the service
  // host strips the original `keep: true` before forwarding, so `params.keep` is
  // gone by the time we route the call. See shared/simulator-api-metadata.ts.
  //
  // The watchdog window is per-call (apiCallWatchdogMs): network-budget APIs
  // (request/downloadFile/uploadFile) get their wx timeout budget + grace so a
  // slow-but-alive HTTP call is never torn down before its handler's own
  // deadline; everything else keeps the flat 5s missing-handler window.
  const keep = params.keep === true || isPersistentSimulatorApi(name)
  const timer = keep
    ? undefined
    : setTimeout(() => {
        const pending = state.pendingApiCalls.get(requestId)
        if (!pending) return
        state.pendingApiCalls.delete(requestId)
        const target = state.appSessions.get(pending.appSessionId)
        if (!target) return
        const fail = { errMsg: `${pending.name}:fail no handler (timeout)` }
        sendCallback(target, pending.callbacks.fail, fail)
        sendCallback(target, pending.callbacks.complete, fail)
      }, apiCallWatchdogMs(name, params))

  state.pendingApiCalls.set(requestId, {
    appSessionId: ap.appSessionId,
    callbacks,
    name,
    timer,
  })

  // Strip the callback ids before forwarding: callback ids are
  // service-host-side identifiers and the simulator runs its own
  // capture-based callback shim. Forwarding them would be both noisy
  // and a potential id-namespace collision.
  const forwardedParams: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(params)) {
    if (k === 'success' || k === 'fail' || k === 'complete') continue
    forwardedParams[k] = v
  }

  const payload: ApiCallPayload = {
    appSessionId: ap.appSessionId,
    bridgeId: page.bridgeId,
    requestId,
    name,
    params: forwardedParams,
    // Echoed back unchanged in the API_RESPONSE so main can ack against the
    // original service-side callback ids without keeping them in pending.
    callbacks,
  }
  ap.simulatorWc.send(E.API_CALL, payload)
}

function handleApiResponse(
  state: RouterState,
  sender: WebContents,
  payload: ApiResponsePayload,
): void {
  const pending = state.pendingApiCalls.get(payload.requestId)
  if (!pending) return

  const ap = state.appSessions.get(pending.appSessionId)
  if (!ap) {
    // Owning app is gone — drop the stale entry regardless of keep.
    state.pendingApiCalls.delete(payload.requestId)
    clearTimeout(pending.timer)
    return
  }
  // Only a simulator window bound to the OWNING session may respond. Membership
  // (senderBoundToSession), not sender-resolution equality: during a soft-reload
  // overlap the shared simulator wc still answers the outgoing session's
  // in-flight calls, which a latest-wins comparison would drop. Validate BEFORE
  // mutating pending state so a spoofed/foreign response can't tear down a
  // live subscription.
  if (!senderBoundToSession(state, sender, ap)) {
    console.warn('[bridge-router] API_RESPONSE rejected: sender not bound to app session')
    return
  }

  // Persistent-subscription fire (keep: true, e.g. audioListen). Re-fire the
  // service-side success callback on EVERY response without tearing the call
  // down: do not delete pending, do not fire `complete`. The 5s no-handler
  // timeout is no longer relevant once the subscription has produced a fire,
  // so clear it but keep the entry alive until page/app teardown (which
  // drains pendingApiCalls in the dispose path).
  // `payload.keep` OR a by-name persistent API: be robust even if the verdict
  // on the wire didn't echo `keep` (the service host strips it), so the router
  // never tears a known subscription (`audioListen`) down as a one-shot.
  if ((payload.keep || isPersistentSimulatorApi(pending.name)) && payload.ok) {
    clearTimeout(pending.timer)
    pending.timer = undefined
    sendCallback(ap, pending.callbacks.success, payload.result)
    return
  }

  // One-shot path (default): fire the verdict's callbacks once and clean up.
  state.pendingApiCalls.delete(payload.requestId)
  clearTimeout(pending.timer)

  if (payload.ok) {
    sendCallback(ap, pending.callbacks.success, payload.result)
    sendCallback(ap, pending.callbacks.complete, payload.result ?? { errMsg: `${pending.name}:ok` })
  } else {
    // The router is a transport, not an author: the simulator-side fail result
    // (errno etc.) must reach the service callbacks intact, so spread it
    // through instead of rebuilding a bare { errMsg }. errMsg is guaranteed
    // non-empty — `||` (not `??`) so an empty string (e.g. an HTTP/2 response
    // whose statusText is always '') falls through payload.errMsg →
    // result.errMsg → the `${name}:fail` default instead of surfacing blank.
    const result =
      payload.result && typeof payload.result === 'object' && !Array.isArray(payload.result)
        ? (payload.result as Record<string, unknown>)
        : undefined
    const resultErrMsg = typeof result?.errMsg === 'string' ? result.errMsg : undefined
    const fail = {
      ...result,
      errMsg: payload.errMsg || resultErrMsg || `${pending.name}:fail`,
    }
    sendCallback(ap, pending.callbacks.fail, fail)
    sendCallback(ap, pending.callbacks.complete, fail)
  }
}

function newRequestId(): string {
  return `apicall_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function extractCallbacks(params: Record<string, unknown>): NavActionPayload['callbacks'] {
  return { success: params.success, fail: params.fail, complete: params.complete }
}

function normalizeParams(params: unknown): Record<string, unknown> {
  return params && typeof params === 'object' && !Array.isArray(params)
    ? params as Record<string, unknown>
    : { value: params }
}

function sendCallback(ap: AppSession, id: unknown, args: unknown): void {
  if (id === undefined || id === null) return
  forwardToService(ap, {
    type: 'triggerCallback',
    target: 'service',
    body: { id, args },
  })
}

// ── Resource helpers ────────────────────────────────────────────────────────

function makeLoadResource(ap: AppSession, page: PageSession, target: 'service' | 'render'): MessageEnvelope {
  return {
    type: 'loadResource',
    target,
    body: {
      appId: ap.appId,
      bridgeId: page.bridgeId,
      pagePath: page.pagePath,
      root: ap.root,
      baseUrl: ap.resourceBaseUrl,
      resourceBaseUrl: ap.resourceBaseUrl,
      // dimina's service runtime reads hostEnv as `{ systemInfo, menuRect }`
      // (core/host-env.js init → getSystemInfo/getMenuRect; invokeAPI resolves
      // getSystemInfoSync/getWindowInfo/getDeviceInfo from hostEnv.systemInfo).
      // The snapshot must be nested under `systemInfo`: a FLAT HostEnvSnapshot
      // leaves `systemInfo` null → `wx.getSystemInfoSync()` returns null and
      // pages reading `.screenWidth` throw. (render does NOT read hostEnv, so
      // this is service-only; the devtools sync-api-patch reads the separate
      // __diminaSpawnContext.hostEnvSnapshot and is unaffected.)
      // menuRect stays null — getMenuButtonBoundingClientRect is served by the
      // sync-api-patch / DeviceShell capsule, not this path.
      hostEnv: { systemInfo: ap.hostEnv, menuRect: null },
    },
  }
}

function forwardToService(ap: AppSession, msg: MessageEnvelope): void {
  if (!ap.serviceWc.isDestroyed()) {
    ap.serviceWc.send(C.TO_SERVICE, { msg })
  }
}

function forwardToRender(ap: AppSession, msg: MessageEnvelope, targetBridgeId?: string): void {
  const renderBridgeId = targetBridgeId || readBridgeId(msg)
  if (!renderBridgeId) {
    throw new Error('[bridge-router] cannot route to render: missing bridgeId in body and no explicit target')
  }
  const page = ap.pages.get(renderBridgeId)
  if (!page) return
  const renderWc = page.renderWc
  if (renderWc && !renderWc.isDestroyed()) {
    renderWc.send(C.TO_RENDER, { msg })
  }
}

function ensureRenderBound(state: RouterState, sender: WebContents, bridgeId: string): PageSession | undefined {
  const page = state.pageSessions.get(bridgeId)
  if (!page) return undefined
  if (page.renderWc !== sender) {
    if (page.renderWc && page.renderWc !== sender && !page.renderWc.isDestroyed()) {
      console.warn(`[bridge-router] page ${bridgeId} render webview swap (wc ${page.renderWc.id} → ${sender.id})`)
    }
    page.renderWc = sender
    state.wcIdToBridgeId.set(sender.id, bridgeId)
    // Consolidate the render-guest bookkeeping teardown onto the connection
    // layer (see foundation.md): the render guest is its own webContents =
    // its own connection; own() ties this cleanup to its lifetime so it
    // fires on destroy, replacing the bespoke `once('destroyed')`. acquire() is
    // idempotent — re-binding the same sender re-uses its connection.
    state.connections.acquire(sender).own(() => {
      const p = state.pageSessions.get(bridgeId)
      if (p && p.renderWc === sender) p.renderWc = null
      if (state.wcIdToBridgeId.get(sender.id) === bridgeId) state.wcIdToBridgeId.delete(sender.id)
    })
  }
  return page
}

function pageFromMsg(state: RouterState, ap: AppSession, msg: MessageEnvelope): PageSession | undefined {
  const target = readBridgeId(msg)
  if (!target) return undefined
  const page = ap.pages.get(target)
  return page
}

function appByWc(state: RouterState, wc: WebContents): AppSession | undefined {
  if (wc.isDestroyed()) return undefined
  const appSessionId = state.serviceWcIdToAppSessionId.get(wc.id)
  if (appSessionId) return state.appSessions.get(appSessionId)
  // A simulator wc hosts several sessions during a soft reload; a message that
  // doesn't name its session belongs to the LATEST still-alive spawn (the Set
  // preserves spawn order).
  const hosted = state.simulatorWcIdToAppSessionIds.get(wc.id)
  if (hosted) {
    let latest: AppSession | undefined
    for (const id of hosted) latest = state.appSessions.get(id) ?? latest
    if (latest) return latest
  }
  const bridgeId = state.wcIdToBridgeId.get(wc.id)
  if (bridgeId) {
    const page = state.pageSessions.get(bridgeId)
    if (page) return state.appSessions.get(page.appSessionId)
  }
  return undefined
}

/**
 * Whether `sender` is authorized to control app session `ap`. A simulator WCV
 * is authorized for EVERY session it hosts (`simulatorWcIdToAppSessionIds` is
 * a membership set, so an older session's own control traffic stays valid
 * while a newer spawn boots on the same wc); any other sender (service host,
 * render guest) resolves one-to-one through `appByWc`.
 */
function senderBoundToSession(state: RouterState, sender: WebContents, ap: AppSession): boolean {
  if (sender.isDestroyed()) return false
  const hosted = state.simulatorWcIdToAppSessionIds.get(sender.id)
  if (hosted) return hosted.has(ap.appSessionId)
  return appByWc(state, sender)?.appSessionId === ap.appSessionId
}

function resolveAppByBridgeId(state: RouterState, bridgeId: string): AppSession | undefined {
  if (state.appSessions.has(bridgeId)) return state.appSessions.get(bridgeId)
  const page = state.pageSessions.get(bridgeId)
  if (page) return state.appSessions.get(page.appSessionId)
  return undefined
}

function bindWc(map: Map<number, string>, wc: WebContents, id: string): void {
  if (wc.isDestroyed()) return
  map.set(wc.id, id)
}

/** Add a session to a simulator wc's hosted set (created on first bind). */
function bindSimulatorWc(map: Map<number, Set<string>>, wc: WebContents, id: string): void {
  if (wc.isDestroyed()) return
  let hosted = map.get(wc.id)
  if (!hosted) {
    hosted = new Set()
    map.set(wc.id, hosted)
  }
  hosted.add(id)
}

function readBridgeId(msg: MessageEnvelope): string | undefined {
  return typeof msg.body?.bridgeId === 'string' ? msg.body.bridgeId : undefined
}

function newBridgeId(): string {
  return `bridge_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function resolveSimulatorWebContents(
  ctx: WorkbenchContext,
  simulatorWcId: number | undefined,
  sender: WebContents,
): WebContents {
  if (!simulatorWcId) return sender ?? ctx.windows.mainWindow.webContents
  return webContents.fromId(simulatorWcId) ?? ctx.windows.mainWindow.webContents
}

// ── Dispose ─────────────────────────────────────────────────────────────────

function disposePageSession(state: RouterState, ap: AppSession, page: PageSession): void {
  if (page.renderWc && !page.renderWc.isDestroyed()) {
    state.wcIdToBridgeId.delete(page.renderWc.id)
  }
  ap.pages.delete(page.bridgeId)
  state.pageSessions.delete(page.bridgeId)
}

// Drain any pending API calls owned by this app session. One-shot calls
// normally self-clean on response/timeout, but persistent (`keep: true`)
// subscriptions (e.g. audioListen) live with their timer cleared until
// teardown — without this they would leak in pendingApiCalls forever.
function drainPendingApiCallsForSession(state: RouterState, appSessionId: string): void {
  for (const [requestId, pending] of state.pendingApiCalls) {
    if (pending.appSessionId !== appSessionId) continue
    clearTimeout(pending.timer)
    state.pendingApiCalls.delete(requestId)
  }
}

// Closes every page's render guest and drops its wc/pageSessions bindings.
// Caller clears `ap.pages` itself right after — this only tears each page
// down, it doesn't touch the map.
function closeSessionPages(state: RouterState, ap: AppSession): void {
  for (const page of ap.pages.values()) {
    if (page.renderWc && !page.renderWc.isDestroyed()) {
      state.wcIdToBridgeId.delete(page.renderWc.id)
      // The render-host <webview> guest is otherwise reclaimed only when its
      // host simulator WCV is destroyed, and that cascade is async. Close it
      // here so a project-close / respawn tears the guest down deterministically
      // rather than leaving the outgoing project's guest alive to be
      // screenshotted or re-resolved by the next project. Idempotent with the
      // cascade (guarded on isDestroyed).
      try { page.renderWc.close() } catch { /* guest already gone */ }
    }
    state.pageSessions.delete(page.bridgeId)
  }
}

// Three-way release of the session's service-host window: pool release (soft
// reuse), pool reclaim of an externally-closed window, or a plain close for
// the unpooled path.
async function releaseServiceWindow(
  state: RouterState,
  ap: AppSession,
  opts: { serviceAlreadyClosed?: boolean },
): Promise<void> {
  if (ap.poolEntryId !== null && state.pool && !opts.serviceAlreadyClosed) {
    // Soft reuse (see foundation.md): the pooled service-host webContents keeps
    // its wc.id but is about to run a NEW app session. Reset its Connection
    // BEFORE returning it to the pool — dispose this session's owned segment
    // (the serviceWc binding cleanup) and swap a fresh one — so an old in-flight
    // response can't bleed into the next session and the next spawn `acquire`s a
    // clean segment. The connection object stays alive (it's reused), so this is
    // reset (not close); a real destroy still closes it via its 'destroyed' hook.
    state.connections.reset(ap.serviceWc.id)
    // Return the window to the pool instead of closing it. Detach the boot
    // listener first (the 'closed' hook already came off with the listener-bag
    // dispose above) so a stale did-finish-load can't boot this disposed
    // session into the next spawn's recycled window.
    if (ap.onServiceBoot && !ap.serviceWindow.isDestroyed()) {
      ap.serviceWindow.webContents.removeListener('did-finish-load', ap.onServiceBoot)
    }
    await state.pool.release(ap.poolEntryId, ap.serviceWindow).catch((error) => {
      console.warn('[bridge-router] pool release failed:', error)
    })
  } else if (ap.poolEntryId !== null && state.pool && opts.serviceAlreadyClosed) {
    // The pooled service window already closed/crashed externally (its 'closed'
    // fired → onServiceClosed → here). `release` is skipped on this path, and the
    // pool only auto-reclaims on render-process-gone — so without this the in-use
    // entry leaks in the pool forever, permanently shrinking capacity. Reclaim
    // the slot explicitly (the window is already gone; releaseDestroyed won't
    // touch it).
    state.pool.releaseDestroyed(ap.poolEntryId)
  } else if (!opts.serviceAlreadyClosed && !ap.serviceWindow.isDestroyed()) {
    ap.serviceWindow.close()
  }
}

function unbindSessionFromSharedMaps(state: RouterState, ap: AppSession, appSessionId: string): void {
  // Value-checked unbind for the service wc: this delete runs after the
  // pool-release await above, so on the pool path the next spawn may have
  // already re-acquired the SAME window and rebound its wc id — only remove
  // an entry that still names THIS session.
  if (state.serviceWcIdToAppSessionId.get(ap.serviceWc.id) === appSessionId) {
    state.serviceWcIdToAppSessionId.delete(ap.serviceWc.id)
  }
  // The simulator wc's hosted set sheds only this session; sessions that are
  // still live on the shared wc (the soft-reload survivor) keep their
  // membership. The map entry goes away with the last session.
  const hosted = state.simulatorWcIdToAppSessionIds.get(ap.simulatorWc.id)
  if (hosted) {
    hosted.delete(appSessionId)
    if (hosted.size === 0) state.simulatorWcIdToAppSessionIds.delete(ap.simulatorWc.id)
  }
}

async function disposeAppSession(
  state: RouterState,
  appSessionId: string,
  opts: { serviceAlreadyClosed?: boolean } = {},
): Promise<void> {
  const ap = state.appSessions.get(appSessionId)
  if (!ap) return
  state.appSessions.delete(appSessionId)
  // Prevent a leaked/stale watchdog: without this, a session disposed while
  // still 'launching' (e.g. project close mid-launch) would fire its timer
  // `LAUNCH_TIMEOUT_MS` later against an already-torn-down session.
  clearLaunchTimer(ap)
  // Remove this session's shutdown-fallback registry entry so the registry does
  // not accumulate one stale closure per respawn. Ordered AFTER the delete
  // above: dispose() runs the wrapped fn (disposeAppSession again), which
  // early-returns now that the session is gone — no recursion, no double-run.
  // (At whole-app shutdown the registry marks the entry released before calling
  // the fn, so this dispose() is a no-op then.)
  const registryHandle = ap.registryHandle
  ap.registryHandle = null
  void registryHandle?.dispose()
  state.appLifecycle.dispose(appSessionId)

  // Evict AppData bridges FIRST — eviction enumerates `ap.pages`, which the
  // page teardown below progressively empties (and finally clears).
  state.evictAppDataBridges(ap)

  drainPendingApiCallsForSession(state, appSessionId)

  closeSessionPages(state, ap)
  ap.pages.clear()

  // Detach every session-scoped hook on emitters that outlive this session —
  // the shared simulator WCV's 'destroyed' and the service window's 'closed' —
  // BEFORE the window is released/closed below: a pool-recycled window must
  // not re-trigger this session's teardown from a stale 'closed', and the
  // simulator wc must not accumulate one dead hook per soft reload until the
  // MaxListeners warning fires. Idempotent with teardown being triggered BY
  // one of these hooks (removing a fired once() is a no-op).
  ap.listenerBag.dispose()

  await releaseServiceWindow(state, ap, opts)

  unbindSessionFromSharedMaps(state, ap, appSessionId)

  // Only the local fallback server needs closing; the dev-server base is owned
  // by the workspace session, not this app session.
  if (ap.resourceServer) {
    await ap.resourceServer.close().catch((error) => {
      console.warn('[bridge-router] resource server close failed:', error)
    })
  }
}

// ── App-config / manifest parsing ───────────────────────────────────────────

/**
 * Fetch+parse `app-config.json`. Pure (no `ctx`, no diagnostics dependency) —
 * a non-2xx response or a parse/network failure reports through `onUnreachable`
 * (the caller routes it into `ctx.diagnostics`) and returns `{}` either way, so
 * the spawn flow always continues with a manifest that just falls back to a
 * single-page/no-tabBar shape (`buildAppManifest`'s fallback).
 */
async function loadAppConfig(
  resourceBase: string,
  onUnreachable?: (info: { url: string; error: unknown }) => void,
): Promise<RawAppConfig> {
  // `resourceBase` is the dir/URL that directly contains `app-config.json`:
  // the dev server's `<base><appId>/<root>/` (http) or the local fallback
  // server root (also http). Both are HTTP, so a single fetch path covers them.
  const cfgUrl = new URL('app-config.json', resourceBase.endsWith('/') ? resourceBase : `${resourceBase}/`).toString()
  try {
    const res = await fetch(cfgUrl)
    if (!res.ok) {
      const error = new Error(`app-config.json fetch ${res.status} at ${cfgUrl}`)
      console.warn(`[bridge-router] no app-config.json at ${cfgUrl} (${res.status})`)
      onUnreachable?.({ url: cfgUrl, error })
      return {}
    }
    return await res.json() as RawAppConfig
  } catch (error) {
    console.warn('[bridge-router] failed to fetch/parse app-config.json:', error)
    onUnreachable?.({ url: cfgUrl, error })
    return {}
  }
}

function buildAppManifest(appConfig: RawAppConfig, fallbackEntry: string): AppManifest {
  const entry = appConfig.app?.entryPagePath || fallbackEntry
  const hasCompiledPages = !!appConfig.app?.pages?.length
  const pages = hasCompiledPages ? appConfig.app!.pages! : [entry]
  const tabBar = appConfig.app?.tabBar && Array.isArray(appConfig.app.tabBar.list) && appConfig.app.tabBar.list.length > 0
    ? appConfig.app.tabBar
    : undefined
  return {
    entryPagePath: normalizePagePath(entry),
    pages: pages.map(normalizePagePath),
    tabBar,
    // 'app-config' means `pages` above is the real compiled list mount gates
    // can trust; 'fallback' means app-config.json was unreachable and `pages`
    // is just the single requested page — nothing to validate membership
    // against, so every gate keyed on this source lets it through unchanged.
    source: hasCompiledPages ? 'app-config' : 'fallback',
  }
}

/**
 * Resolve the root page a spawn actually mounts against the compiled
 * manifest. The request is trusted verbatim unless the manifest is a real
 * compiled one (`source === 'app-config'`) AND the request is absent from its
 * `pages` — in that case the request is unmountable (most commonly a start
 * page removed by a hot reload) and resolution falls back to
 * `manifest.entryPagePath`, or `manifest.pages[0]` when even the entry isn't a
 * member. A `'fallback'` manifest contains only the request itself, so there
 * is trivially nothing to fall back from.
 */
function resolveRootPagePath(
  manifest: AppManifest,
  requestedPagePath: string,
): { resolvedPagePath: string; pageFallbackApplied: boolean } {
  if (manifest.source !== 'app-config' || manifest.pages.includes(requestedPagePath)) {
    return { resolvedPagePath: requestedPagePath, pageFallbackApplied: false }
  }
  const resolvedPagePath = manifest.pages.includes(manifest.entryPagePath)
    ? manifest.entryPagePath
    : manifest.pages[0]
  return { resolvedPagePath, pageFallbackApplied: true }
}

function resolvePageWindowConfig(appConfig: RawAppConfig, pagePath: string): PageWindowConfig {
  const normalized = normalizePagePath(pagePath)
  const appWindow = appConfig.app?.window ?? {}
  const pageEntry = appConfig.modules?.[normalized]
  const pageWindow = pageEntry?.window ?? {}
  return {
    navigationBarTitleText:
      pageWindow.navigationBarTitleText ?? appWindow.navigationBarTitleText ?? '',
    navigationBarBackgroundColor:
      pageWindow.navigationBarBackgroundColor ?? appWindow.navigationBarBackgroundColor ?? '#ffffff',
    navigationBarTextStyle:
      pageWindow.navigationBarTextStyle ?? appWindow.navigationBarTextStyle ?? 'black',
    navigationStyle:
      pageWindow.navigationStyle ?? appWindow.navigationStyle ?? 'default',
    homeButton: pageWindow.homeButton ?? appWindow.homeButton,
    backgroundColor:
      pageWindow.backgroundColor ?? appWindow.backgroundColor,
    backgroundTextStyle:
      pageWindow.backgroundTextStyle ?? appWindow.backgroundTextStyle,
    enablePullDownRefresh:
      pageWindow.enablePullDownRefresh ?? appWindow.enablePullDownRefresh,
    disableScroll: pageWindow.disableScroll ?? appWindow.disableScroll,
  }
}

function isTabPage(appConfig: RawAppConfig, pagePath: string): boolean {
  const list = appConfig.app?.tabBar?.list ?? []
  const normalized = normalizePagePath(pagePath)
  return list.some(item => normalizePagePath(item.pagePath) === normalized)
}

function normalizePagePath(p: string): string {
  return p ? p.replace(/^\/+/, '') : ''
}

// ── Protocol handlers ───────────────────────────────────────────────────────

function installResourceProtocolHandlers(ctx: WorkbenchContext, state: RouterState): void {
  const handler: ProtocolHandler = async (request) => {
    const url = new URL(request.url)
    const ap = resolveAppByBridgeId(state, url.hostname)
    if (!ap) return new Response('Bridge session not found', { status: 404 })
    const target = new URL(url.pathname.replace(/^\/+/, '') + url.search, ap.resourceBaseUrl)
    return fetch(target)
  }

  const simulatorSession = electronSession.fromPartition(SHARED_MINIAPP_PARTITION)
  try { protocol.unhandle('dmb-resource') } catch {}
  try { simulatorSession.protocol.unhandle('dmb-resource') } catch {}
  protocol.handle('dmb-resource', handler)
  simulatorSession.protocol.handle('dmb-resource', handler)

  // Per-project partition sessions need the SAME resource handler so each
  // project's render/service can load `dmb-resource://…`. Install on every
  // miniapp partition (current + future); track installed sessions for teardown.
  const perProjectSessions = new Set<Electron.Session>()
  const unregisterConfigurator = registerMiniappSessionConfigurator((sess) => {
    if (perProjectSessions.has(sess)) return
    perProjectSessions.add(sess)
    try { sess.protocol.unhandle('dmb-resource') } catch {}
    sess.protocol.handle('dmb-resource', handler)
  })

  ctx.registry.add(() => {
    unregisterConfigurator()
    try { protocol.unhandle('dmb-resource') } catch {}
    try { simulatorSession.protocol.unhandle('dmb-resource') } catch {}
    for (const sess of perProjectSessions) {
      try { sess.protocol.unhandle('dmb-resource') } catch {}
    }
  })
}

function makeHostEnv(snapshot: Partial<HostEnvSnapshot> | undefined): HostEnvSnapshot {
  return {
    brand: 'devtools',
    model: 'Electron',
    platform: process.platform,
    system: `${process.platform} ${process.versions.electron || ''}`.trim(),
    version: process.versions.electron || '0.0.0',
    SDKVersion: 'native-host-phase-1',
    pixelRatio: 2,
    screenWidth: 390,
    screenHeight: 844,
    windowWidth: 390,
    windowHeight: 844,
    statusBarHeight: 24,
    language: app.getLocale(),
    theme: 'light',
    ...snapshot,
  }
}
