import { app, BrowserWindow, ipcMain, protocol, session as electronSession, webContents } from 'electron'
import type { IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import { BRIDGE_CHANNELS as C, SIMULATOR_EVENTS as E } from '../../shared/bridge-channels.js'
import type {
  ApiCallPayload,
  ApiResponsePayload,
  AppManifest,
  DisposePayload,
  HostEnvSnapshot,
  MessageEnvelope,
  NavActionPayload,
  NavCallbackPayload,
  PageClosePayload,
  PageLifecyclePayload,
  PageOpenRequest,
  PageOpenResult,
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
import type { WorkbenchContext } from '../services/workbench-context.js'
import { startDiminaResourceServer, toSourceUrl, type DiminaResourceServer } from '../services/dimina-resource-server.js'
import { createServiceHostWindow } from '../windows/service-host-window/create.js'

const STACK_ID = 'stack_0'

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
  resourceServer: DiminaResourceServer
  hostEnv: HostEnvSnapshot
  appConfig: RawAppConfig
  manifest: AppManifest
  pages: Map<string, PageSession>
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
  windowConfig: PageWindowConfig
}

type ProtocolHandler = (request: GlobalRequest) => Promise<Response>
type GlobalRequest = Parameters<typeof protocol.handle>[1] extends (request: infer T) => unknown ? T : Request

interface PendingApiCall {
  appSessionId: string
  callbacks: { success?: unknown; fail?: unknown; complete?: unknown }
  name: string
  timer: NodeJS.Timeout
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
}

/** Default timeout for a simulator-forwarded API call. */
const API_CALL_TIMEOUT_MS = 5_000

export function installBridgeRouter(ctx: WorkbenchContext): void {
  const state: RouterState = {
    appSessions: new Map(),
    pageSessions: new Map(),
    wcIdToAppSessionId: new Map(),
    wcIdToBridgeId: new Map(),
    pendingApiCalls: new Map(),
  }

  installResourceProtocolHandlers(ctx, state)

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
    void disposeAppSession(state, target.appSessionId)
  }
  ipcMain.on(C.DISPOSE, onDispose)
  ctx.registry.add(() => { ipcMain.removeListener(C.DISPOSE, onDispose) })

  const onServiceInvoke = (event: IpcMainEvent, payload: ServiceInvokePayload): void => {
    const ap = appByWc(state, event.sender)
    if (!ap) return
    const page = state.pageSessions.get(payload.bridgeId) ?? state.pageSessions.get(ap.appSessionId)
    if (!page) return
    routeFromService(state, ap, page, payload.msg, ctx)
  }
  ipcMain.on(C.SERVICE_INVOKE, onServiceInvoke)
  ctx.registry.add(() => { ipcMain.removeListener(C.SERVICE_INVOKE, onServiceInvoke) })

  const onServicePublish = (event: IpcMainEvent, payload: ServicePublishPayload): void => {
    const ap = appByWc(state, event.sender)
    if (!ap) return
    forwardToRender(ap, payload.msg, payload.targetBridgeId)
  }
  ipcMain.on(C.SERVICE_PUBLISH, onServicePublish)
  ctx.registry.add(() => { ipcMain.removeListener(C.SERVICE_PUBLISH, onServicePublish) })

  const onRenderInvoke = (event: IpcMainEvent, payload: RenderInvokePayload): void => {
    const page = ensureRenderBound(state, event.sender, payload.bridgeId)
    if (!page) return
    const ap = state.appSessions.get(page.appSessionId)
    if (!ap) return
    routeFromRender(state, ap, page, payload.msg, ctx)
  }
  ipcMain.on(C.RENDER_INVOKE, onRenderInvoke)
  ctx.registry.add(() => { ipcMain.removeListener(C.RENDER_INVOKE, onRenderInvoke) })

  const onRenderPublish = (event: IpcMainEvent, payload: RenderPublishPayload): void => {
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
  const pkgRoot = path.resolve(opts.pkgRoot || process.cwd())
  const root = opts.root || 'main'
  const resourceRoot = path.resolve(pkgRoot, root)
  const resourceServer = await startDiminaResourceServer(resourceRoot)
  const hostEnv = makeHostEnv(opts.hostEnvSnapshot)

  const appConfig = await loadAppConfig(resourceRoot)
  const manifest = buildAppManifest(appConfig, pagePath)
  const rootWindowConfig = resolvePageWindowConfig(appConfig, pagePath)
  const isTab = isTabPage(appConfig, pagePath)

  const serviceWindow = createServiceHostWindow({
    bridgeId,
    appId,
    pagePath,
    pkgRoot,
    resourceBaseUrl: resourceServer.baseUrl,
    hostEnvSnapshot: hostEnv,
  })

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
    resourceServer,
    hostEnv,
    appConfig,
    manifest,
    pages: new Map(),
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
    windowConfig: rootWindowConfig,
  }

  state.appSessions.set(appSessionId, appSession)
  state.pageSessions.set(bridgeId, rootPage)
  appSession.pages.set(bridgeId, rootPage)
  bindWc(state.wcIdToAppSessionId, serviceWindow.webContents, appSessionId)
  bindWc(state.wcIdToAppSessionId, simulatorWc, appSessionId)
  ctx.registry.add(() => disposeAppSession(state, appSessionId))

  serviceWindow.once('closed', () => {
    void disposeAppSession(state, appSessionId, { serviceAlreadyClosed: true })
  })

  serviceWindow.webContents.once('did-finish-load', () => {
    void bootServiceHost(state, appSession)
  })

  return {
    appSessionId,
    bridgeId,
    pagePath,
    serviceWcId: serviceWindow.webContents.id,
    resourceBaseUrl: resourceServer.baseUrl,
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

async function bootServiceHost(state: RouterState, ap: AppSession): Promise<void> {
  await injectLogicBundle(ap)
  // serviceLoaded is flipped only when service responds with
  // `serviceResourceLoaded`; see handleContainerMsg. Setting it here would
  // race a per-page `resourceLoaded` ahead of the service-side handler.
  forwardToService(ap, makeLoadResource(ap, ap.pages.get(ap.appSessionId)!, 'service'))
}

async function injectLogicBundle(ap: AppSession): Promise<void> {
  const logicPath = path.join(ap.pkgRoot, ap.root, 'logic.js')
  try {
    const logicContent = await fs.readFile(logicPath, 'utf8')
    await ap.serviceWc.executeJavaScript(`${logicContent}\n//# sourceURL=${toSourceUrl(logicPath)}`, true)
  } catch (error) {
    console.warn('[bridge-router] unable to inject service logic.js:', error)
  }
}

function maybeSendResourceLoaded(ap: AppSession, page: PageSession): void {
  if (page.resourceLoadedSent || !ap.serviceLoaded || !page.renderLoaded) return
  page.resourceLoadedSent = true
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
    if (page.renderWc && !page.renderWc.isDestroyed()) {
      page.renderWc.send(C.TO_RENDER, { msg: makeLoadResource(ap, page, 'render') })
    }
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
      break
    case 'invokeAPI':
      void handleSimulatorApi(state, ap, page, msg.body, ctx)
      break
    case 'serviceHostError':
      console.warn('[bridge-router] service host error:', msg.body)
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
  const timer = setTimeout(() => {
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
  state.pendingApiCalls.delete(payload.requestId)
  clearTimeout(pending.timer)

  const ap = state.appSessions.get(pending.appSessionId)
  if (!ap) return
  // Only the simulator window bound to that app may respond.
  const senderApp = appByWc(state, sender)
  if (!senderApp || senderApp.appSessionId !== ap.appSessionId) {
    console.warn('[bridge-router] API_RESPONSE rejected: sender not bound to app session')
    return
  }

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
      baseUrl: ap.resourceServer.baseUrl,
      resourceBaseUrl: ap.resourceServer.baseUrl,
      hostEnv: ap.hostEnv,
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
    sender.once('destroyed', () => {
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

  for (const page of ap.pages.values()) {
    if (page.renderWc && !page.renderWc.isDestroyed()) {
      state.wcIdToBridgeId.delete(page.renderWc.id)
    }
    state.pageSessions.delete(page.bridgeId)
  }
  ap.pages.clear()

  if (!opts.serviceAlreadyClosed && !ap.serviceWindow.isDestroyed()) {
    ap.serviceWindow.close()
  }
  state.wcIdToAppSessionId.delete(ap.serviceWc.id)
  state.wcIdToAppSessionId.delete(ap.simulatorWc.id)

  await ap.resourceServer.close().catch((error) => {
    console.warn('[bridge-router] resource server close failed:', error)
  })
}

// ── App-config / manifest parsing ───────────────────────────────────────────

async function loadAppConfig(resourceRoot: string): Promise<RawAppConfig> {
  const cfgPath = path.join(resourceRoot, 'app-config.json')
  try {
    const raw = await fs.readFile(cfgPath, 'utf8')
    return JSON.parse(raw) as RawAppConfig
  } catch (error) {
    if (isNotFound(error)) {
      console.warn(`[bridge-router] no app-config.json at ${cfgPath}`)
      return {}
    }
    console.warn('[bridge-router] failed to parse app-config.json:', error)
    return {}
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: string }).code === 'ENOENT'
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
    const target = new URL(url.pathname.replace(/^\/+/, '') + url.search, ap.resourceServer.baseUrl)
    return fetch(target)
  }

  const simulatorSession = electronSession.fromPartition('persist:simulator')
  try { protocol.unhandle('dmb-resource') } catch {}
  try { simulatorSession.protocol.unhandle('dmb-resource') } catch {}
  protocol.handle('dmb-resource', handler)
  simulatorSession.protocol.handle('dmb-resource', handler)
  ctx.registry.add(() => {
    try { protocol.unhandle('dmb-resource') } catch {}
    try { simulatorSession.protocol.unhandle('dmb-resource') } catch {}
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
