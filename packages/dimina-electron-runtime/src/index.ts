import {
  app,
  protocol,
  session as electronSession,
  type BrowserWindow,
  type Rectangle,
  type WebContentsView,
} from 'electron'
import {
  createConnectionRegistry,
  DisposableRegistry,
} from '@dimina-kit/electron-deck/main'
import { installBridgeRouter } from './main/ipc/bridge-router.js'
import { createEmbeddedMiniappView } from './main/embedded-view.js'
import type { RuntimeContext } from './main/runtime-context.js'
import {
  createRuntimeEvents,
  type RuntimeEventMap,
  type RuntimeEvents,
} from './main/runtime-events.js'
import { createRuntimeStorageApi } from './main/services/storage.js'
import { setupSimulatorTempFiles } from './main/services/simulator-temp-files/index.js'
import {
  clearSimulatorServicewechatReferer,
  setSimulatorServicewechatReferer,
} from './main/services/simulator/referer.js'
import { setupSimulatorSessionPolicy } from './main/services/views/simulator-session-policy.js'
import { SHARED_MINIAPP_PARTITION } from './main/services/views/miniapp-partition.js'
import {
  createSimulatorApiRegistry,
  type SimulatorApiHandler,
} from './main/services/simulator/custom-apis.js'
import { resolveRuntimeAssetPaths } from './main/utils/paths.js'
import { SIMULATOR_EVENTS } from './shared/bridge-channels.js'
import type { NativeDeviceInfo } from './shared/runtime-types.js'

export interface ElectronRuntimeProjectOptions {
  projectPath: string
  entryPagePath?: string
  query?: Record<string, string>
  scene?: number
  watch?: boolean
}

export interface ElectronRuntimeCompilerSession {
  port: number
  appInfo: {
    appId: string
    name?: string
    path?: string
  }
  close(): Promise<void>
}

export interface ElectronRuntimeCompilerAdapter {
  openProject(options: {
    projectPath: string
    simulatorDir: string
    watch?: boolean
    autoReload?: boolean
    onRebuild?: (info?: { changedPaths: string[]; styleOnly: boolean }) => void
    onBuildError?: (error: unknown) => void
  }): Promise<ElectronRuntimeCompilerSession>
}

export interface CreateElectronRuntimeOptions {
  /** Existing host window; the SDK never creates, closes, or quits it. */
  hostWindow: BrowserWindow
  /** Host/compiler integration. The runtime deliberately has no devkit dependency. */
  adapter: ElectronRuntimeCompilerAdapter
  apiNamespaces?: string[]
  /**
   * Absolute path to this package's copied dist/ directory. Required when the
   * host bundles the runtime's main-process code instead of externalizing it.
   */
  assetsRoot?: string
}

export interface ElectronMiniappSession {
  readonly view: WebContentsView
  readonly ready: Promise<void>
  readonly appInfo: ElectronRuntimeCompilerSession['appInfo']
  readonly port: number
  setBounds(bounds: Rectangle): void
  dispose(): Promise<void>
}

export interface ElectronRuntime {
  openProject(options: ElectronRuntimeProjectOptions): Promise<ElectronMiniappSession>
  registerApi(name: string, handler: SimulatorApiHandler): () => void
  setDevice(device: NativeDeviceInfo): void
  on<K extends keyof RuntimeEventMap>(
    name: K,
    listener: (payload: RuntimeEventMap[K]) => void,
  ): () => void
  dispose(): Promise<void>
}

let activeRuntime = false
let schemesRegistered = false

/**
 * Process-global privileged scheme descriptors. Hosts that register their own
 * schemes must merge these into their single pre-ready Electron registration.
 */
export const ELECTRON_RUNTIME_SCHEMES = [
  {
    scheme: 'difile',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
  {
    scheme: 'dmb-resource',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
] as const satisfies readonly Electron.CustomScheme[]

/**
 * Register the custom schemes required by file-system/temp-file APIs.
 * Call once before `app.whenReady()` only when the host has no other privileged
 * schemes. Electron permits one process-global registration call; other hosts
 * should merge ELECTRON_RUNTIME_SCHEMES into their own call instead.
 */
export function registerElectronRuntimeSchemes(): void {
  if (schemesRegistered) return
  if (app.isReady()) {
    throw new Error('registerElectronRuntimeSchemes() must run before Electron app is ready')
  }
  protocol.registerSchemesAsPrivileged([...ELECTRON_RUNTIME_SCHEMES])
  schemesRegistered = true
}

function buildSimulatorUrl(
  port: number,
  appId: string,
  options: ElectronRuntimeProjectOptions,
  apiNamespaces: string[],
): string {
  const pagePath = options.entryPagePath || 'pages/index/index'
  const query = { ...(options.query ?? {}), scene: String(options.scene ?? 1001) }
  const pageSpec = Object.keys(query).length === 0
    ? pagePath
    : `${pagePath}?${new URLSearchParams(query).toString()}`
  const params = new URLSearchParams({
    appId,
    entry: pageSpec,
    page: pageSpec,
    embedded: '1',
  })
  if (apiNamespaces.length) params.set('apiNamespaces', apiNamespaces.join(','))
  return `http://127.0.0.1:${port}/simulator.html?${params.toString()}`
}

async function captureCleanup(
  errors: unknown[],
  cleanup: () => void | Promise<void>,
): Promise<void> {
  try {
    await cleanup()
  } catch (error) {
    errors.push(error)
  }
}

function throwCleanupErrors(errors: unknown[], message: string): void {
  if (errors.length === 0) return
  if (errors.length === 1) throw errors[0]
  throw new AggregateError(errors, message)
}

export async function createElectronRuntime(
  options: CreateElectronRuntimeOptions,
): Promise<ElectronRuntime> {
  if (!app.isReady()) {
    throw new Error('@dimina-kit/electron-runtime must be created after Electron app is ready')
  }
  if (activeRuntime) {
    throw new Error('@dimina-kit/electron-runtime currently supports one active runtime per process')
  }
  if (!options.hostWindow || options.hostWindow.isDestroyed()) {
    throw new Error('hostWindow must be a live BrowserWindow')
  }
  const assets = resolveRuntimeAssetPaths(options.assetsRoot)
  const registry = new DisposableRegistry()
  const events: RuntimeEvents = createRuntimeEvents()
  const simulatorApis = createSimulatorApiRegistry()
  let compilerSession: ElectronRuntimeCompilerSession | null = null
  let miniappSession: ElectronMiniappSession | null = null
  let embeddedSession: ReturnType<typeof createEmbeddedMiniappView> | null = null
  let readyStatusOff: (() => void) | null = null
  let projectPath = ''
  let closing = false
  let projectGeneration = 0
  let lifecycleQueue: Promise<void> = Promise.resolve()

  const ctx = {
    apiNamespaces: options.apiNamespaces ?? [],
    assets,
    workspace: {
      getSession: () => compilerSession,
      getProjectPath: () => projectPath,
      isClosing: () => closing,
    },
    windows: { mainWindow: options.hostWindow },
    registry,
    connections: createConnectionRegistry(),
    simulatorApis,
    events,
  } as RuntimeContext

  const cleanupProcessResources = async (errors: unknown[]): Promise<void> => {
    await captureCleanup(errors, () => registry.dispose())
    for (const cleanup of [() => simulatorApis.clear(), () => events.clear()]) {
      try {
        cleanup()
      } catch (error) {
        errors.push(error)
      }
    }
  }

  activeRuntime = true
  try {
    installBridgeRouter(ctx)
    ctx.storageApi = createRuntimeStorageApi((appId) => ctx.bridge?.getServiceWc(appId) ?? null)
    registry.add(setupSimulatorSessionPolicy())
    registry.add(setupSimulatorTempFiles(
      electronSession.fromPartition(SHARED_MINIAPP_PARTITION),
    ))
  } catch (setupError) {
    const errors: unknown[] = [setupError]
    await cleanupProcessResources(errors)
    activeRuntime = false
    throwCleanupErrors(errors, 'Electron runtime setup and rollback failed')
  }

  let disposed = false
  let disposePromise: Promise<void> | null = null

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = lifecycleQueue.then(operation, operation)
    lifecycleQueue = result.then(() => undefined, () => undefined)
    return result
  }

  const closeActiveSession = async (owner?: ElectronMiniappSession): Promise<void> => {
    if (owner && miniappSession !== owner) return
    if (!compilerSession && !embeddedSession) return
    projectGeneration++
    closing = true
    const viewSession = embeddedSession
    const compileSession = compilerSession
    readyStatusOff?.()
    readyStatusOff = null
    miniappSession = null
    embeddedSession = null
    compilerSession = null
    projectPath = ''
    clearSimulatorServicewechatReferer()
    try {
      const errors: unknown[] = []
      if (viewSession) {
        await captureCleanup(errors, () => viewSession.dispose())
      }
      if (compileSession) {
        await captureCleanup(errors, () => compileSession.close())
      }
      throwCleanupErrors(errors, 'Mini-app session disposal failed')
    } finally {
      closing = false
    }
  }

  return {
    openProject(projectOptions) {
      return enqueue(async () => {
        if (disposed) throw new Error('Electron runtime is disposed')
        await closeActiveSession()
        projectPath = projectOptions.projectPath

        const generation = ++projectGeneration
        let latestUrl = ''
        let rebuildRevision = 0
        const relaunchWhenReady = (revision: number): void => {
          const target = miniappSession
          if (!target || !latestUrl) return
          void target.ready.then(() => {
            if (
              revision !== rebuildRevision
              || generation !== projectGeneration
              || miniappSession !== target
            ) return
            const wc = target.view.webContents
            if (!wc.isDestroyed()) {
              wc.send(SIMULATOR_EVENTS.RELAUNCH, { url: latestUrl })
            }
          }).catch(() => {
            // The readiness rejection is already exposed through session.ready.
          })
        }
        let session: ElectronRuntimeCompilerSession
        try {
          session = await options.adapter.openProject({
            projectPath,
            simulatorDir: assets.simulatorDir,
            watch: projectOptions.watch,
            autoReload: false,
            onRebuild: () => {
              if (generation !== projectGeneration) return
              relaunchWhenReady(++rebuildRevision)
            },
            onBuildError: (error) => {
              if (generation !== projectGeneration) return
              events.emit('session-status', {
                appId: compilerSession?.appInfo.appId ?? '',
                phase: 'launch-failed',
                code: 'compile-error',
                reason: error instanceof Error ? error.message : String(error),
              })
            },
          })
        } catch (error) {
          if (generation === projectGeneration) projectPath = ''
          throw error
        }
        if (!session.appInfo?.appId) {
          await session.close()
          projectPath = ''
          throw new Error('compiler adapter returned a session without appInfo.appId')
        }
        compilerSession = session
        setSimulatorServicewechatReferer(session.appInfo.appId)
        latestUrl = buildSimulatorUrl(
          session.port,
          session.appInfo.appId,
          projectOptions,
          ctx.apiNamespaces,
        )
        let embedded: ReturnType<typeof createEmbeddedMiniappView>
        try {
          embedded = createEmbeddedMiniappView(ctx, {
            appId: session.appInfo.appId,
            projectPath,
            simulatorUrl: latestUrl,
            assets,
          })
        } catch (error) {
          compilerSession = null
          projectPath = ''
          await session.close()
          throw error
        }

        const ready = new Promise<void>((resolve, reject) => {
          let settled = false
          const settle = (action: () => void): void => {
            if (settled) return
            settled = true
            readyStatusOff?.()
            readyStatusOff = null
            action()
          }
          readyStatusOff = events.on('session-status', (status) => {
            if (status.appId !== session.appInfo.appId) return
            if (status.phase !== 'launch-failed' && status.phase !== 'crashed') return
            settle(() => reject(new Error(
              status.reason || `Mini-app runtime ${status.phase}${status.code ? `: ${status.code}` : ''}`,
            )))
          })
          embedded.ready.then(
            () => settle(resolve),
            (error) => settle(() => reject(error)),
          )
        })
        // Disposal may reject readiness before a host starts awaiting it.
        // Preserve the rejection for callers while preventing a process-level
        // unhandledRejection in that timing window.
        void ready.catch(() => {})

        const result: ElectronMiniappSession = {
          view: embedded.view,
          ready,
          appInfo: session.appInfo,
          port: session.port,
          setBounds: (bounds) => embedded.view.setBounds(bounds),
          dispose: () => enqueue(() => closeActiveSession(result)),
        }
        embeddedSession = embedded
        miniappSession = result
        if (rebuildRevision > 0) relaunchWhenReady(rebuildRevision)
        return result
      })
    },
    registerApi: (name, handler) => simulatorApis.register(name, handler),
    setDevice: (device) => ctx.bridge?.setDevice(device),
    on: (name, listener) => events.on(name, listener),
    dispose() {
      if (disposePromise) return disposePromise
      disposed = true
      disposePromise = enqueue(async () => {
        const errors: unknown[] = []
        try {
          await captureCleanup(errors, closeActiveSession)
          await cleanupProcessResources(errors)
        } finally {
          activeRuntime = false
        }
        throwCleanupErrors(errors, 'Electron runtime disposal failed')
      })
      return disposePromise
    },
  }
}

export type {
  NativeDeviceInfo,
  NotchType,
  SafeAreaInsets,
  SyncStorageChange,
} from './shared/runtime-types.js'
export type {
  RuntimeEventMap,
  SessionRuntimeStatus,
} from './main/runtime-events.js'
export type { SimulatorApiHandler } from './main/services/simulator/custom-apis.js'
export {
  ElectronRuntimeSessionDisposedError,
} from './main/embedded-view.js'
