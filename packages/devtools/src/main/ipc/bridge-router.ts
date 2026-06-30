import { app, BrowserWindow, ipcMain, protocol, session as electronSession, webContents } from 'electron'
import type { IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { BRIDGE_CHANNELS as C, SIMULATOR_EVENTS as E, deviceInfoToHostEnv } from '../../shared/bridge-channels.js'
import type { NativeDeviceInfo } from '../../shared/ipc-channels.js'
import { isPersistentSimulatorApi } from '../../shared/simulator-api-metadata.js'
import { devtoolsPackageRoot } from '../utils/paths.js'
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
import type { ConnectionRegistry, DebugTap } from '@dimina-kit/electron-deck/main'
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
import { createConsoleForwarder } from '../services/console-forward/index.js'
import { STORAGE_API_NAMES } from '../services/simulator-storage/index.js'

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

/** Hard ceiling on the pre-warm pool, mirroring ServiceHostPool/doc §3.3. */
const PREWARM_MAX_POOL_SIZE = 4

/**
 * Resolve the pre-warm pool size from env (doc §6). Returns 0 (OFF) unless
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

/** debugTap (§7) is opt-in via `DIMINA_DEBUG_TAP=1` — off everywhere else. */
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
  /** The `'closed'` listener bound to the service window, kept so dispose can
   * detach it before releasing the window back to the pool. */
  onServiceClosed: (() => void) | null
  /** The pool-path `'did-finish-load'` boot listener, kept so dispose can detach
   * it before releasing the (recycled) window — otherwise a stale listener could
   * boot this disposed session into the next spawn's window. Null on the fresh
   * path (which uses a self-removing `once`). */
  onServiceBoot: (() => void) | null
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
  /** serviceWc + simulatorWc → appSessionId. */
  wcIdToAppSessionId: Map<number, string>
  /** renderWc → bridgeId. */
  wcIdToBridgeId: Map<number, string>
  /** requestId → pending API_CALL forwarded to a simulator window. */
  pendingApiCalls: Map<string, PendingApiCall>
  /** Pre-warm pool for service-host windows; null when pooling is disabled. */
  pool: ServiceHostPool | null
  /** Fan-out for render-side activity (domReady / active-page); set in install. */
  emitRenderEvent: (event: RenderEvent) => void
  /**
   * Per-webContents connection registry (foundation.md §4). Render guests and
   * service-host windows are acquired here so their per-wc bookkeeping tears
   * down with the connection (destroy → close, pool reuse → reset) instead of
   * bespoke `once('destroyed')` listeners scattered through the router.
   */
  connections: ConnectionRegistry
  /**
   * Flag-gated ring buffer (foundation.md §7) over the cross-wc bridge message
   * stream. Off by default (near-free no-op); when `DIMINA_DEBUG_TAP=1` it
   * records every SERVICE_INVOKE / RENDER_INVOKE / *_PUBLISH / API_RESPONSE at
   * the dispatch chokepoint (connection id + appSession + channel + direction)
   * so the cross-wc state machine is inspectable. This is debugTap's first real
   * consumer — the observability hangs on the LIVE runtime, not the
   * not-yet-integrated async envelope.
   */
  debugTap: DebugTap
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
const API_CALL_TIMEOUT_MS = 5_000

/**
 * Accessor over the bridge-router's private `RouterState`, stashed on
 * `ctx.bridge` so other main-process services (simulator-storage, automation,
 * appdata) can resolve live WebContents handles without owning router state.
 * All getters resolve fresh each call (the pre-warm pool can swap windows on
 * respawn, so cached handles go stale).
 */
/**
 * Render-side activity worth re-reading panel data on: a page's DOM mounted
 * (`domReady`) or the visible page changed (`activePage`). Panels that pull
 * from the active render guest (WXML/element-inspect) subscribe via
 * `BridgeRouterHandle.onRenderEvent` so they can refresh without polling.
 */
export interface RenderEvent {
  kind: 'domReady' | 'activePage'
  appId: string
  bridgeId: string
  /** activePage only: the now-visible page's route (bare pagePath), if known.
   * Lets the current-page panel push the route without a separate lookup. */
  pagePath?: string
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
   * The flag-gated debugTap (§7) over the bridge message stream. Exposed so a
   * hidden devtools panel / automation can read `.entries()` when
   * `DIMINA_DEBUG_TAP=1`; a no-op snapshot otherwise. Optional so the many
   * partial `BridgeRouterHandle` test mocks don't each have to stub it.
   */
  debugTap?: DebugTap
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
  // Same-appId matches prefer the MOST RECENT spawn (Maps preserve insertion
  // order): after a respawn/reopen the newest session is the live one — the
  // first match could be a just-superseded session mid-teardown.
  if (appId) {
    let match: AppSession | undefined
    for (const ap of state.appSessions.values()) if (ap.appId === appId) match = ap
    if (match) return match
  }
  const appInfo = ctx.workspace?.getSession?.()?.appInfo as { appId?: string } | undefined
  const activeAppId = appInfo?.appId
  if (activeAppId) {
    let match: AppSession | undefined
    for (const ap of state.appSessions.values()) if (ap.appId === activeAppId) match = ap
    if (match) return match
  }
  // During a project close the workspace nulls its session BEFORE the bridge app
  // session is torn down (disposeSession runs before disposeAll). Resolving here
  // would hand a consumer the closing project's dying guest, so refuse to guess
  // while a close is in flight.
  if (ctx.workspace?.isClosing?.()) return undefined
  // No appId hint and no workspace session to disambiguate. Picking by appId is
  // impossible, so fall back to the most-recent spawn — but ONLY when every live
  // session belongs to the same app. Same-appId multiples are a respawn/reopen
  // in progress where the newest is the live one (insertion order = spawn
  // order). Multiple DISTINCT appIds mean a previous project is mid-teardown
  // alongside the new one; any pick is a guess that can resolve the WRONG
  // project's content (the screenshot/inspect-stale-app bug class), so prefer
  // null over a wrong guess.
  let last: AppSession | undefined
  const distinctAppIds = new Set<string>()
  for (const ap of state.appSessions.values()) {
    last = ap
    distinctAppIds.add(ap.appId)
  }
  return distinctAppIds.size <= 1 ? last : undefined
}

export function installBridgeRouter(ctx: WorkbenchContext): void {
  const state: RouterState = {
    appSessions: new Map(),
    pageSessions: new Map(),
    wcIdToAppSessionId: new Map(),
    wcIdToBridgeId: new Map(),
    pendingApiCalls: new Map(),
    pool: null,
    emitRenderEvent: () => {},
    connections: ctx.connections,
    debugTap: createDebugTap({ enabled: resolveDebugTapEnabled() }),
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
    // Defer warm-up off the cold-start critical path (doc §3.3: app.ready +
    // idle). Warming eagerly here races main-window startup — it creates an
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
  }
  ctx.bridge = bridgeHandle

  // Always-on guest console fan-out. Owns `ctx.guestConsole` (the sink the
  // consoleLog case below routes to) so that render-layer console output is
  // mirrored into the service host's own console — surfacing it in the embedded
  // Chrome DevTools (attached to the service host) prefixed `[视图]` — regardless
  // of whether an automation client is connected. Automation now SUBSCRIBES to
  // this forwarder instead of clobbering `ctx.guestConsole`.
  const consoleForwarder = createConsoleForwarder(bridgeHandle)
  ctx.consoleForwarder = consoleForwarder
  ctx.guestConsole = consoleForwarder
  ctx.registry.add(() => {
    void consoleForwarder.dispose()
    ctx.consoleForwarder = undefined
    ctx.guestConsole = undefined
  })

  // DeviceShell → main: record the visible top-of-stack page bridgeId so the
  // accessor above can resolve "the active page". Sender-validated against the
  // app that owns it; ignored for unknown apps/pages.
  const onActivePage = (event: IpcMainEvent, payload: ActivePagePayload): void => {
    const ap = state.appSessions.get(payload.appSessionId)
    if (!ap) return
    const senderApp = appByWc(state, event.sender)
    if (!senderApp || senderApp.appSessionId !== ap.appSessionId) return
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
    const senderApp = appByWc(state, event.sender)
    if (!senderApp || senderApp.appSessionId !== ap.appSessionId) return
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
      const senderApp = appByWc(state, event.sender)
      if (ap && senderApp && senderApp.appSessionId === ap.appSessionId) {
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
    const senderApp = appByWc(state, event.sender)
    if (senderApp && senderApp.appSessionId !== target.appSessionId) {
      console.warn(`[bridge-router] DISPOSE rejected: sender belongs to ${senderApp.appSessionId}, target ${target.appSessionId}`)
      return
    }
    // AppData bridge eviction happens inside disposeAppSession (single
    // chokepoint shared with the simulator-WCV 'destroyed' path).
    void disposeAppSession(state, target.appSessionId)
  }
  ipcMain.on(C.DISPOSE, onDispose)
  ctx.registry.add(() => { ipcMain.removeListener(C.DISPOSE, onDispose) })

  // debugTap (§7) ingress recorder — near-free no-op unless DIMINA_DEBUG_TAP=1.
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
  )
  const manifest = buildAppManifest(appConfig, pagePath)
  const rootWindowConfig = resolvePageWindowConfig(appConfig, pagePath)
  const isTab = isTabPage(appConfig, pagePath)

  // Acquire a pre-warmed service-host window when pooling is enabled; otherwise
  // construct one fresh (default). A pooled/fallback window is warmed on
  // about:blank and must be navigated to the spawn URL below; the fresh path
  // navigates inside createServiceHostWindow.
  const usedPool = state.pool !== null
  let poolEntryId: string | null = null
  let serviceWindow: BrowserWindow
  if (state.pool) {
    const acquired = await state.pool.acquire(serviceHostSpec())
    serviceWindow = acquired.win
    poolEntryId = acquired.entryId
  } else {
    serviceWindow = createServiceHostWindow({
      bridgeId,
      appId,
      // Same (appId, projectPath) pair the simulator WCV uses, so this project's
      // service host and render guests land on ONE partition while a different
      // project with the same appId is isolated. Use the path captured at spawn
      // ENTRY (workspaceProjectPath), not a re-read: a project switch during the
      // awaits above would otherwise give the service host a different path than
      // the simulator WCV was built with, splitting the partition.
      projectPath: workspaceProjectPath || undefined,
      pagePath,
      pkgRoot,
      root,
      resourceBaseUrl,
      hostEnvSnapshot: hostEnv,
      apiNamespaces,
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
    onServiceClosed: null,
    onServiceBoot: null,
  }

  const rootPage: PageSession = {
    bridgeId,
    appSessionId,
    pagePath,
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
  bindWc(state.wcIdToAppSessionId, serviceWindow.webContents, appSessionId)
  bindWc(state.wcIdToAppSessionId, simulatorWc, appSessionId)
  // Track the service-host webContents as a Connection (foundation.md §4.3) and
  // own this session's serviceWc→appSessionId binding on its CURRENT lifetime
  // segment. On a pooled-window REUSE, `disposeAppSession` calls
  // `connections.reset(serviceWc.id)` → this owned cleanup fires + a fresh
  // segment opens, so the next session rebinding the same wc starts clean; on a
  // real destroy the connection closes and fires it too. The cleanup is guarded
  // by `appSessionId` so it only clears a binding that is still THIS session's.
  // (The simulatorWc binding stays manual in `disposeAppSession`: the simulator
  // wc outlives individual app sessions — cross-connection state, §4.4 — so it
  // cannot hang off any single session's segment.)
  state.connections.acquire(serviceWindow.webContents).own(() => {
    if (state.wcIdToAppSessionId.get(appSession.serviceWc.id) === appSessionId) {
      state.wcIdToAppSessionId.delete(appSession.serviceWc.id)
    }
  })
  ctx.registry.add(() => disposeAppSession(state, appSessionId))

  const onServiceClosed = (): void => {
    void disposeAppSession(state, appSessionId, { serviceAlreadyClosed: true })
  }
  appSession.onServiceClosed = onServiceClosed
  serviceWindow.once('closed', onServiceClosed)

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
  simulatorWc.once('destroyed', onSimulatorDestroyed)
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
    void navigateServiceHost(
      serviceWindow,
      buildServiceHostSpawnUrl({
        bridgeId,
        appId,
        pagePath,
        pkgRoot,
        root,
        resourceBaseUrl,
        hostEnvSnapshot: hostEnv,
        apiNamespaces,
      }),
    )
  } else {
    // Fresh window: its only navigation is service.html (issued inside
    // createServiceHostWindow), so the first did-finish-load is the spawn load.
    serviceWindow.webContents.once('did-finish-load', () => {
      void bootServiceHost(state, appSession, ctx)
    })
  }

  return {
    appSessionId,
    bridgeId,
    pagePath,
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
  const senderApp = appByWc(state, event.sender)
  if (!senderApp || senderApp.appSessionId !== opts.appSessionId) {
    throw new Error('[bridge-router] PAGE_OPEN rejected: caller not bound to app session')
  }

  const pagePath = normalizePagePath(opts.pagePath)
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
  const senderApp = appByWc(state, sender)
  if (!senderApp || senderApp.appSessionId !== ap.appSessionId) {
    console.warn('[bridge-router] PAGE_CLOSE rejected: caller not bound to app session')
    return
  }
  disposePageSession(state, ap, page)
}

function handlePageLifecycle(state: RouterState, sender: WebContents, payload: PageLifecyclePayload): void {
  const ap = state.appSessions.get(payload.appSessionId)
  if (!ap) return
  const senderApp = appByWc(state, sender)
  if (!senderApp || senderApp.appSessionId !== ap.appSessionId) return

  forwardToService(ap, {
    type: payload.event,
    target: 'service',
    body: { bridgeId: payload.bridgeId },
  })
}

function handleNavCallback(state: RouterState, sender: WebContents, payload: NavCallbackPayload): void {
  const ap = state.appSessions.get(payload.appSessionId)
  if (!ap) return
  const senderApp = appByWc(state, sender)
  if (!senderApp || senderApp.appSessionId !== ap.appSessionId) return

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
  ap.logicInjected = await injectLogicBundle(ap)
  if (!ap.logicInjected) {
    // The compiled logic.js never executed, so `modDefine` registered nothing.
    // Sending `loadResource` now would run `modRequire('app')` against an empty
    // registry and throw the cryptic `module app not found` — masking the real
    // cause (unreachable resource tree / failed compile / unresolved appId).
    // Skip it and surface one actionable diagnostic instead; the render side
    // gates on the same flag in `routeFromRender`.
    reportLogicLoadFailure(ap, ctx)
    return
  }
  // serviceLoaded is flipped only when service responds with
  // `serviceResourceLoaded`; see handleContainerMsg. Setting it here would
  // race a per-page `resourceLoaded` ahead of the service-side handler.
  forwardToService(ap, makeLoadResource(ap, ap.pages.get(ap.appSessionId)!, 'service'))
  // Flush any render `loadResource` that arrived (renderHostReady) while
  // injection was in-flight — now that the bundle is confirmed present.
  for (const page of ap.pages.values()) {
    if (page.renderLoadPending) {
      page.renderLoadPending = false
      sendRenderLoadResource(ap, page)
    }
  }
}

function sendRenderLoadResource(ap: AppSession, page: PageSession): void {
  if (page.renderWc && !page.renderWc.isDestroyed()) {
    page.renderWc.send(C.TO_RENDER, { msg: makeLoadResource(ap, page, 'render') })
  }
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
 * unreachable" is known with certainty. Goes to the main-process log AND the
 * guest console sink so it surfaces in the devtools Console panel where the
 * developer would otherwise see only the misleading `module app not found`.
 */
function reportLogicLoadFailure(ap: AppSession, ctx: WorkbenchContext): void {
  const hint = ap.appId === 'unknown'
    ? ' appId could not be resolved (it fell back to "unknown") — the mini-program likely failed to compile or its project manifest/app config is missing.'
    : ''
  const message
    = `[dimina-kit] Failed to load the mini-program logic bundle from ${logicBundleUrl(ap)}. `
    + 'The service runtime has no registered modules, so no page can mount.'
    + hint
    + ` Verify the project compiled successfully and that the resource server serves "${ap.appId}/${ap.root}/".`
  console.error(message)
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
      break
    case 'invokeAPI':
      void handleSimulatorApi(state, ap, page, msg.body, ctx)
      break
    case 'serviceHostError':
      console.warn('[bridge-router] service host error:', msg.body)
      break
    case 'consoleLog':
      // Native-host console capture: the render-host / service-host guest preloads
      // monkeypatch console.* and post each entry here (one case handles both —
      // distinguish via msg.body.source). Forward to the console sink (set by the
      // automation server under native-host) so it can rebroadcast as App.logAdded.
      // Guarded + non-throwing: console capture must never break message routing.
      ctx.guestConsole?.emit(msg.body)
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
    return
  }

  if (NAV_ACTION_NAMES.has(name)) {
    const payload: NavActionPayload = {
      appSessionId: ap.appSessionId,
      bridgeId: page.bridgeId,
      name: name as NavActionPayload['name'],
      params,
      callbacks: extractCallbacks(params),
    }
    if (!ap.simulatorWc.isDestroyed()) {
      ap.simulatorWc.send(E.NAV_ACTION, payload)
    } else {
      const fail = { errMsg: `${name}:fail simulator window destroyed` }
      sendCallback(ap, params.fail, fail)
      sendCallback(ap, params.complete, fail)
    }
    return
  }

  if (TAB_ACTION_NAMES.has(name)) {
    const payload: TabActionPayload = {
      appSessionId: ap.appSessionId,
      bridgeId: page.bridgeId,
      name: name as TabActionPayload['name'],
      params,
      callbacks: extractCallbacks(params),
    }
    if (!ap.simulatorWc.isDestroyed()) {
      ap.simulatorWc.send(E.TAB_ACTION, payload)
    } else {
      const fail = { errMsg: `${name}:fail simulator window destroyed` }
      sendCallback(ap, params.fail, fail)
      sendCallback(ap, params.complete, fail)
    }
    return
  }

  // Native-host storage unification: route async wx.setStorage/getStorage/etc.
  // to the service-host window's file:// store (the same store the *Sync APIs +
  // the Storage panel use), instead of forwarding to the simulator guest's
  // http:// origin. Without this, async writes and sync writes diverge across
  // two origins even for the running mini-app.
  if (ctx.storageApi && STORAGE_API_NAMES.has(name)) {
    try {
      const result = await ctx.storageApi.invoke(ap.appId, name, params)
      sendCallback(ap, params.success, result)
      sendCallback(ap, params.complete, result)
    } catch (error) {
      const failResult = { errMsg: `${name}:fail ${error instanceof Error ? error.message : String(error)}` }
      sendCallback(ap, params.fail, failResult)
      sendCallback(ap, params.complete, failResult)
    }
    return
  }

  // Main-process registry (downstream-registered host APIs via
  // instance.registerSimulatorApi). If the name is not registered here, fall
  // through to the simulator-window forwarding branch — the simulator-resident
  // MiniApp owns the DOM-touching defaults (wx.getSystemInfo, chooseImage,
  // chooseMedia, fs.*, …) and the bridge-router can't run those itself.
  if (ctx.simulatorApis.has(name)) {
    try {
      const result = await ctx.simulatorApis.invoke(name, params)
      sendCallback(ap, params.success, result)
      sendCallback(ap, params.complete, result)
    } catch (error) {
      const failResult = { errMsg: `${name}:fail ${error instanceof Error ? error.message : String(error)}` }
      sendCallback(ap, params.fail, failResult)
      sendCallback(ap, params.complete, failResult)
    }
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
  // event fires (which can be well past the 5s no-handler window). Arming the
  // one-shot timeout would tear the subscription down before it ever delivers,
  // so keep calls run without a timeout and are reaped on page/app teardown.
  // Recognise persistent subscriptions BY NAME (`audioListen`) too: the service
  // host strips the original `keep: true` before forwarding, so `params.keep` is
  // gone by the time we route the call. See shared/simulator-api-metadata.ts.
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
      }, API_CALL_TIMEOUT_MS)

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
  // Only the simulator window bound to that app may respond. Validate BEFORE
  // mutating pending state so a spoofed/foreign response can't tear down a
  // live subscription.
  const senderApp = appByWc(state, sender)
  if (!senderApp || senderApp.appSessionId !== ap.appSessionId) {
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
    const fail = { errMsg: payload.errMsg ?? `${pending.name}:fail` }
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
    // layer (foundation.md §4 / P2): the render guest is its own webContents =
    // its own connection (§4.4); own() ties this cleanup to its lifetime so it
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
  const appSessionId = state.wcIdToAppSessionId.get(wc.id)
  if (appSessionId) return state.appSessions.get(appSessionId)
  const bridgeId = state.wcIdToBridgeId.get(wc.id)
  if (bridgeId) {
    const page = state.pageSessions.get(bridgeId)
    if (page) return state.appSessions.get(page.appSessionId)
  }
  return undefined
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

async function disposeAppSession(
  state: RouterState,
  appSessionId: string,
  opts: { serviceAlreadyClosed?: boolean } = {},
): Promise<void> {
  const ap = state.appSessions.get(appSessionId)
  if (!ap) return
  state.appSessions.delete(appSessionId)

  // Evict AppData bridges FIRST — eviction enumerates `ap.pages`, which the
  // page teardown below progressively empties (and finally clears).
  state.evictAppDataBridges(ap)

  // Drain any pending API calls owned by this app session. One-shot calls
  // normally self-clean on response/timeout, but persistent (`keep: true`)
  // subscriptions (e.g. audioListen) live with their timer cleared until
  // teardown — without this they would leak in pendingApiCalls forever.
  for (const [requestId, pending] of state.pendingApiCalls) {
    if (pending.appSessionId !== appSessionId) continue
    clearTimeout(pending.timer)
    state.pendingApiCalls.delete(requestId)
  }

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
  ap.pages.clear()

  if (ap.poolEntryId !== null && state.pool && !opts.serviceAlreadyClosed) {
    // Soft reuse (foundation.md §4.3): the pooled service-host webContents keeps
    // its wc.id but is about to run a NEW app session. Reset its Connection
    // BEFORE returning it to the pool — dispose this session's owned segment
    // (the serviceWc binding cleanup) and swap a fresh one — so an old in-flight
    // response can't bleed into the next session and the next spawn `acquire`s a
    // clean segment. The connection object stays alive (it's reused), so this is
    // reset (not close); a real destroy still closes it via its 'destroyed' hook.
    state.connections.reset(ap.serviceWc.id)
    // Return the window to the pool instead of closing it. Detach the per-spawn
    // listeners first so the pool resetting/recycling (or a later pool-side
    // destroy) can't re-trigger disposeAppSession or boot this disposed session
    // into the next spawn's recycled window.
    if (ap.onServiceClosed && !ap.serviceWindow.isDestroyed()) {
      ap.serviceWindow.removeListener('closed', ap.onServiceClosed)
    }
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
    // touch it). (Audit A1)
    state.pool.releaseDestroyed(ap.poolEntryId)
  } else if (!opts.serviceAlreadyClosed && !ap.serviceWindow.isDestroyed()) {
    ap.serviceWindow.close()
  }
  state.wcIdToAppSessionId.delete(ap.serviceWc.id)
  state.wcIdToAppSessionId.delete(ap.simulatorWc.id)

  // Only the local fallback server needs closing; the dev-server base is owned
  // by the workspace session, not this app session.
  if (ap.resourceServer) {
    await ap.resourceServer.close().catch((error) => {
      console.warn('[bridge-router] resource server close failed:', error)
    })
  }
}

// ── App-config / manifest parsing ───────────────────────────────────────────

async function loadAppConfig(resourceBase: string): Promise<RawAppConfig> {
  // `resourceBase` is the dir/URL that directly contains `app-config.json`:
  // the dev server's `<base><appId>/<root>/` (http) or the local fallback
  // server root (also http). Both are HTTP, so a single fetch path covers them.
  const cfgUrl = new URL('app-config.json', resourceBase.endsWith('/') ? resourceBase : `${resourceBase}/`).toString()
  try {
    const res = await fetch(cfgUrl)
    if (!res.ok) {
      console.warn(`[bridge-router] no app-config.json at ${cfgUrl} (${res.status})`)
      return {}
    }
    return await res.json() as RawAppConfig
  } catch (error) {
    console.warn('[bridge-router] failed to fetch/parse app-config.json:', error)
    return {}
  }
}

function buildAppManifest(appConfig: RawAppConfig, fallbackEntry: string): AppManifest {
  const entry = appConfig.app?.entryPagePath || fallbackEntry
  const pages = appConfig.app?.pages?.length ? appConfig.app.pages : [entry]
  const tabBar = appConfig.app?.tabBar && Array.isArray(appConfig.app.tabBar.list) && appConfig.app.tabBar.list.length > 0
    ? appConfig.app.tabBar
    : undefined
  return { entryPagePath: normalizePagePath(entry), pages: pages.map(normalizePagePath), tabBar }
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
