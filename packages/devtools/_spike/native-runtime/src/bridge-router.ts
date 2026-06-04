import { app, BrowserWindow, ipcMain, WebContents } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { CHANNELS } from './shared/channels.js'
import type { HostEnvSnapshot, MessageEnvelope, SpawnRequest, SpawnResult } from './shared/types.js'

interface BridgeSession {
  bridgeId: string
  appId: string
  pagePath: string
  serviceWindow: BrowserWindow
  serviceWc: WebContents
  renderWcs: Map<string, WebContents>
  simulatorWc: WebContents
  serviceLoaded: boolean
  renderLoaded: Set<string>
  resourceLoadedSent: boolean
  scene: number
  query: Record<string, unknown>
  hostEnv: HostEnvSnapshot
}

interface BridgeRouterOptions {
  runtimeRoot: string
}

export class BridgeRouter {
  private readonly sessions = new Map<string, BridgeSession>()
  private readonly runtimeRoot: string

  constructor(opts: BridgeRouterOptions) {
    this.runtimeRoot = opts.runtimeRoot
    this.installIpc()
  }

  async spawn(appId: string, requestedBridgeId: string | undefined, simulatorWc: WebContents, opts: SpawnRequest): Promise<SpawnResult> {
    const bridgeId = requestedBridgeId || `bridge_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`
    const pagePath = opts.pagePath || 'pages/index/index'
    const hostEnv = this.makeHostEnv()
    const serviceWindow = new BrowserWindow({
      width: 900,
      height: 700,
      show: false,
      webPreferences: {
        contextIsolation: false,
        nodeIntegration: false,
        sandbox: false,
        preload: path.join(this.runtimeRoot, 'dist', 'service-host', 'preload.js'),
        partition: 'persist:dimina-native-runtime-spike',
        devTools: true,
      },
    })

    const session: BridgeSession = {
      bridgeId,
      appId,
      pagePath,
      serviceWindow,
      serviceWc: serviceWindow.webContents,
      renderWcs: new Map(),
      simulatorWc,
      serviceLoaded: false,
      renderLoaded: new Set(),
      resourceLoadedSent: false,
      scene: opts.scene || 1001,
      query: opts.query || {},
      hostEnv,
    }
    this.sessions.set(bridgeId, session)

    const serviceUrl = new URL(pathToFileURL(path.join(this.runtimeRoot, 'src', 'service-host', 'service.html')).toString())
    serviceUrl.searchParams.set('bridgeId', bridgeId)
    serviceUrl.searchParams.set('appId', appId)
    serviceUrl.searchParams.set('pagePath', pagePath)

    serviceWindow.webContents.once('did-finish-load', async () => {
      const logicPath = path.join(this.runtimeRoot, 'hello-world', 'logic.js')
      const logicContent = await fs.readFile(logicPath, 'utf8')
      await serviceWindow.webContents.executeJavaScript(`${logicContent}\n//# sourceURL=${pathToFileURL(logicPath).toString()}`, true)
      console.log('[native-runtime] service logic injected', { bridgeId, logicPath })
      serviceWindow.webContents.send(CHANNELS.TO_SERVICE, {
        msg: this.makeLoadResource(session, 'service'),
      })
      serviceWindow.webContents.openDevTools({ mode: 'detach' })
    })

    await serviceWindow.loadURL(serviceUrl.toString())
    return { bridgeId, pagePath }
  }

  private installIpc() {
    ipcMain.on(CHANNELS.SERVICE_INVOKE, (event, payload: { bridgeId: string, msg: MessageEnvelope }) => {
      const session = this.requireSession(payload.bridgeId)
      this.routeFromService(session, payload.msg)
    })

    ipcMain.on(CHANNELS.SERVICE_PUBLISH, (_event, payload: { bridgeId: string, targetBridgeId?: string, msg: MessageEnvelope }) => {
      const session = this.requireSession(payload.bridgeId)
      this.forwardToRender(session, payload.msg, payload.targetBridgeId)
    })

    ipcMain.on(CHANNELS.RENDER_INVOKE, (event, payload: { bridgeId: string, msg: MessageEnvelope }) => {
      const session = this.requireSession(payload.bridgeId)
      this.routeFromRender(session, payload.msg, event.sender)
    })

    ipcMain.on(CHANNELS.RENDER_PUBLISH, (event, payload: { bridgeId: string, msg: MessageEnvelope }) => {
      const session = this.requireSession(payload.bridgeId)
      this.registerRender(session, event.sender, payload.msg.body?.bridgeId as string | undefined)
      this.forwardToService(session, payload.msg)
    })

    ipcMain.on(CHANNELS.DISPOSE, (_event, payload: { bridgeId: string }) => {
      this.dispose(payload.bridgeId)
    })
  }

  private routeFromService(session: BridgeSession, msg: MessageEnvelope) {
    if (msg.target === 'render') {
      this.forwardToRender(session, msg)
      return
    }
    if (msg.target !== 'container' && msg.type !== 'serviceResourceLoaded') {
      throw new Error(`[native-runtime] unsupported service target: ${msg.target}`)
    }
    this.handleContainerMsg(session, msg)
  }

  private routeFromRender(session: BridgeSession, msg: MessageEnvelope, sender: WebContents) {
    const bodyBridgeId = msg.body?.bridgeId as string | undefined
    this.registerRender(session, sender, bodyBridgeId)

    if (msg.type === 'renderHostReady') {
      sender.send(CHANNELS.TO_RENDER, {
        msg: this.makeLoadResource(session, 'render'),
      })
      return
    }

    if (msg.target === 'service') {
      this.forwardToService(session, msg)
      return
    }
    if (msg.target !== 'container') {
      throw new Error(`[native-runtime] unsupported render target: ${msg.target}`)
    }
    this.handleContainerMsg(session, msg)
  }

  private handleContainerMsg(session: BridgeSession, msg: MessageEnvelope) {
    console.log('[native-runtime] container msg', msg.type, msg.body)
    switch (msg.type) {
      case 'serviceResourceLoaded':
        session.serviceLoaded = true
        this.maybeSendResourceLoaded(session)
        break
      case 'renderResourceLoaded':
        session.renderLoaded.add((msg.body.bridgeId as string | undefined) || session.bridgeId)
        this.maybeSendResourceLoaded(session)
        break
      case 'domReady':
        session.simulatorWc.send('simulator:dom-ready', { bridgeId: session.bridgeId })
        break
      case 'invokeAPI':
        this.handleInvokeApi(session, msg.body)
        break
      default:
        console.warn('[native-runtime] unhandled container msg', msg.type, msg.body)
    }
  }

  private handleInvokeApi(session: BridgeSession, body: Record<string, unknown>) {
    const name = String(body.name || '')
    const params = (body.params || {}) as Record<string, unknown>
    if (name !== 'getSystemInfo' && name !== 'getSystemInfoAsync') {
      throw new Error(`[native-runtime] unsupported API in Phase 0: ${name}`)
    }
    const result = this.makeHostEnv()
    this.sendCallback(session, params.success, result)
    this.sendCallback(session, params.complete, result)
  }

  private sendCallback(session: BridgeSession, id: unknown, args: unknown) {
    if (!id) {
      return
    }
    this.forwardToService(session, {
      type: 'triggerCallback',
      target: 'service',
      body: { id, args },
    })
  }

  private maybeSendResourceLoaded(session: BridgeSession) {
    if (session.resourceLoadedSent || !session.serviceLoaded || session.renderLoaded.size === 0) {
      return
    }
    session.resourceLoadedSent = true
    this.forwardToService(session, {
      type: 'resourceLoaded',
      target: 'service',
      body: {
        bridgeId: session.bridgeId,
        scene: session.scene,
        pagePath: session.pagePath,
        query: session.query,
        stackId: 'stack_0',
      },
    })
  }

  private makeLoadResource(session: BridgeSession, target: 'service' | 'render'): MessageEnvelope {
    return {
      type: 'loadResource',
      target,
      body: {
        appId: session.appId,
        bridgeId: session.bridgeId,
        pagePath: session.pagePath,
        root: '.',
        baseUrl: `${pathToFileURL(this.runtimeRoot).toString()}/`,
        hostEnv: session.hostEnv,
      },
    }
  }

  private forwardToService(session: BridgeSession, msg: MessageEnvelope) {
    session.serviceWc.send(CHANNELS.TO_SERVICE, { msg })
  }

  private forwardToRender(session: BridgeSession, msg: MessageEnvelope, targetBridgeId?: string) {
    const renderId = targetBridgeId || (msg.body?.bridgeId as string | undefined) || session.bridgeId
    const renderWc = session.renderWcs.get(renderId) || [...session.renderWcs.values()][0]
    if (!renderWc) {
      throw new Error(`[native-runtime] no render webContents for bridgeId=${session.bridgeId}`)
    }
    renderWc.send(CHANNELS.TO_RENDER, { msg })
  }

  private registerRender(session: BridgeSession, sender: WebContents, bridgeId = session.bridgeId) {
    if (!session.renderWcs.has(bridgeId)) {
      session.renderWcs.set(bridgeId, sender)
      console.log('[native-runtime] render registered', { bridgeId, wcId: sender.id })
    }
  }

  private requireSession(bridgeId: string) {
    const session = this.sessions.get(bridgeId)
    if (!session) {
      throw new Error(`[native-runtime] session not found: ${bridgeId}`)
    }
    return session
  }

  private dispose(bridgeId: string) {
    const session = this.sessions.get(bridgeId)
    if (!session) {
      return
    }
    session.serviceWindow.close()
    this.sessions.delete(bridgeId)
  }

  private makeHostEnv(): HostEnvSnapshot {
    return {
      brand: 'Apple',
      model: 'Electron PoC',
      platform: process.platform,
      system: `${process.platform} ${process.versions.electron || ''}`.trim(),
      version: process.versions.electron || '0.0.0',
      SDKVersion: 'native-runtime-spike',
      pixelRatio: 2,
      screenWidth: 390,
      screenHeight: 844,
      windowWidth: 390,
      windowHeight: 844,
      statusBarHeight: 24,
      language: app.getLocale(),
      theme: 'light',
    }
  }
}
