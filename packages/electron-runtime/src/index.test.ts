import { beforeEach, describe, expect, it, vi } from 'vitest'

const stubs = vi.hoisted(() => {
  let appReady = true
  let failSessionPolicy = false
  let nextViewId = 1
  const bridgeCleanup = vi.fn<() => void | Promise<void>>()
  const sessionPolicyCleanup = vi.fn()
  const tempFilesCleanup = vi.fn()
  const createDefaultView = () => {
    const webContents = {
      id: nextViewId++,
      isDestroyed: () => false,
      send: vi.fn(),
    }
    return {
      view: {
        webContents,
        setBounds: vi.fn(),
      },
      ready: Promise.resolve(),
      dispose: vi.fn(async () => {}),
    }
  }
  return {
    assets: {
      root: '/runtime/dist',
      simulatorDir: '/runtime/dist/simulator',
      simulatorPreloadPath: '/runtime/dist/preload/simulator.cjs',
      renderHostHtmlPath: '/runtime/dist/render-host/pageFrame.html',
      renderHostPreloadPath: '/runtime/dist/render-host/preload.cjs',
      serviceHostHtmlPath: '/runtime/dist/service-host/service.html',
      serviceHostPreloadPath: '/runtime/dist/service-host/preload.cjs',
    },
    setAppReady(value: boolean) {
      appReady = value
    },
    setSessionPolicyFailure(value: boolean) {
      failSessionPolicy = value
    },
    shouldFailSessionPolicy: () => failSessionPolicy,
    isAppReady: () => appReady,
    registerSchemes: vi.fn(),
    bridgeCleanup,
    sessionPolicyCleanup,
    tempFilesCleanup,
    createDefaultView,
    createView: vi.fn(createDefaultView),
  }
})

vi.mock('electron', () => ({
  app: { isReady: stubs.isAppReady },
  protocol: { registerSchemesAsPrivileged: stubs.registerSchemes },
  session: { fromPartition: () => ({}) },
}))

vi.mock('@dimina-kit/electron-deck/main', () => {
  class DisposableRegistry {
    private readonly disposers: Array<() => unknown> = []
    add(value: { dispose(): unknown } | (() => unknown)) {
      const dispose = typeof value === 'function' ? value : () => value.dispose()
      this.disposers.push(dispose)
      return { dispose }
    }
    async dispose() {
      for (const dispose of this.disposers.reverse()) await dispose()
    }
  }
  return {
    DisposableRegistry,
    createConnectionRegistry: () => ({}),
  }
})

vi.mock('./main/ipc/bridge-router.js', () => ({
  installBridgeRouter: (ctx: Record<string, unknown>) => {
    ;(ctx.registry as { add(dispose: () => void): void }).add(stubs.bridgeCleanup)
    ctx.bridge = {
      getServiceWc: () => null,
      setDevice: vi.fn(),
    }
  },
}))

vi.mock('./main/embedded-view.js', () => ({
  createEmbeddedMiniappView: stubs.createView,
}))

vi.mock('./main/utils/paths.js', () => ({
  resolveRuntimeAssetPaths: () => stubs.assets,
}))

vi.mock('./main/services/simulator-temp-files/index.js', () => ({
  setupSimulatorTempFiles: () => ({ dispose: stubs.tempFilesCleanup }),
}))

vi.mock('./main/services/views/simulator-session-policy.js', () => ({
  setupSimulatorSessionPolicy: () => {
    if (stubs.shouldFailSessionPolicy()) throw new Error('session-policy setup failed')
    return { dispose: stubs.sessionPolicyCleanup }
  },
}))

import {
  ELECTRON_RUNTIME_SCHEMES,
  createElectronRuntime,
  registerElectronRuntimeSchemes,
  type ElectronRuntimeCompilerAdapter,
  type ElectronRuntimeCompilerSession,
} from './index.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

const hostWindow = {
  isDestroyed: () => false,
} as never

describe('createElectronRuntime', () => {
  beforeEach(() => {
    stubs.setAppReady(true)
    stubs.setSessionPolicyFailure(false)
    vi.clearAllMocks()
    stubs.createView.mockImplementation(stubs.createDefaultView)
  })

  it('registers its file/resource schemes before Electron readiness', () => {
    stubs.setAppReady(false)
    registerElectronRuntimeSchemes()
    expect(stubs.registerSchemes).toHaveBeenCalledOnce()
    expect(stubs.registerSchemes.mock.calls[0]?.[0]).toEqual(expect.arrayContaining([
      expect.objectContaining({ scheme: 'difile' }),
      expect.objectContaining({ scheme: 'dmb-resource' }),
    ]))
    expect(ELECTRON_RUNTIME_SCHEMES.map(({ scheme }) => scheme))
      .toEqual(['difile', 'dmb-resource'])
  })

  it('requires the host to wait for Electron app readiness', async () => {
    stubs.setAppReady(false)
    await expect(createElectronRuntime({
      hostWindow,
      adapter: { openProject: vi.fn() },
    })).rejects.toThrow(/after Electron app is ready/)
  })

  it('serializes project opens and an old session cannot dispose the new one', async () => {
    const first = deferred<ElectronRuntimeCompilerSession>()
    const second = deferred<ElectronRuntimeCompilerSession>()
    const closeA = vi.fn(async () => {})
    const closeB = vi.fn(async () => {})
    const openProject = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)

    const runtime = await createElectronRuntime({
      hostWindow,
      adapter: { openProject },
    })
    const pendingA = runtime.openProject({ projectPath: '/miniapp/a' })
    const pendingB = runtime.openProject({ projectPath: '/miniapp/b' })
    await vi.waitFor(() => expect(openProject).toHaveBeenCalledTimes(1))

    first.resolve({
      port: 3101,
      appInfo: { appId: 'a' },
      close: closeA,
    })
    const sessionA = await pendingA

    await vi.waitFor(() => expect(openProject).toHaveBeenCalledTimes(2))
    expect(closeA).toHaveBeenCalledTimes(1)
    second.resolve({
      port: 3102,
      appInfo: { appId: 'b' },
      close: closeB,
    })
    const sessionB = await pendingB

    await sessionA.dispose()
    expect(closeB).not.toHaveBeenCalled()
    sessionB.setBounds({ x: 1, y: 2, width: 300, height: 600 })
    expect(stubs.createView.mock.results[1]?.value.view.setBounds)
      .toHaveBeenCalledWith({ x: 1, y: 2, width: 300, height: 600 })

    await runtime.dispose()
    expect(closeB).toHaveBeenCalledTimes(1)
  })

  it('rolls back partial process-global setup before allowing a retry', async () => {
    const rollback = deferred<void>()
    stubs.bridgeCleanup.mockReturnValueOnce(rollback.promise)
    stubs.setSessionPolicyFailure(true)
    const failedRuntime = createElectronRuntime({
      hostWindow,
      adapter: { openProject: vi.fn() },
    })
    let rollbackSettled = false
    void failedRuntime.then(
      () => { rollbackSettled = true },
      () => { rollbackSettled = true },
    )
    await vi.waitFor(() => expect(stubs.bridgeCleanup).toHaveBeenCalledOnce())
    expect(rollbackSettled).toBe(false)
    rollback.resolve()
    await expect(failedRuntime).rejects.toThrow('session-policy setup failed')
    expect(rollbackSettled).toBe(true)

    stubs.setSessionPolicyFailure(false)
    const runtime = await createElectronRuntime({
      hostWindow,
      adapter: { openProject: vi.fn() },
    })
    await runtime.dispose()
  })

  it('continues compiler and global cleanup when view disposal fails', async () => {
    const view = stubs.createDefaultView()
    const viewFailure = new Error('view cleanup failed')
    view.dispose.mockRejectedValueOnce(viewFailure)
    stubs.createView.mockReturnValueOnce(view)
    const closeCompiler = vi.fn(async () => {})
    const runtime = await createElectronRuntime({
      hostWindow,
      adapter: {
        openProject: vi.fn(async () => ({
          port: 3101,
          appInfo: { appId: 'cleanup' },
          close: closeCompiler,
        })),
      },
    })
    await runtime.openProject({ projectPath: '/miniapp/cleanup' })

    const firstDispose = runtime.dispose()
    expect(runtime.dispose()).toBe(firstDispose)
    await expect(firstDispose).rejects.toThrow('view cleanup failed')
    expect(closeCompiler).toHaveBeenCalledOnce()
    expect(stubs.bridgeCleanup).toHaveBeenCalledOnce()
    expect(stubs.sessionPolicyCleanup).toHaveBeenCalledOnce()
    expect(stubs.tempFilesCleanup).toHaveBeenCalledOnce()

    const replacement = await createElectronRuntime({
      hostWindow,
      adapter: { openProject: vi.fn() },
    })
    await replacement.dispose()
  })

  it('waits for the embedded shell before delivering a watcher relaunch', async () => {
    const readyGate = deferred<void>()
    const view = stubs.createDefaultView()
    view.ready = readyGate.promise
    stubs.createView.mockReturnValueOnce(view)
    let onRebuild: (() => void) | undefined
    const runtime = await createElectronRuntime({
      hostWindow,
      adapter: {
        openProject: vi.fn(async (
          options: Parameters<ElectronRuntimeCompilerAdapter['openProject']>[0],
        ) => {
          onRebuild = options.onRebuild
          return {
            port: 3101,
            appInfo: { appId: 'watch-ready' },
            close: vi.fn(async () => {}),
          }
        }),
      },
    })
    const session = await runtime.openProject({
      projectPath: '/miniapp/watch-ready',
      watch: true,
    })

    onRebuild?.()
    onRebuild?.()
    expect(view.view.webContents.send).not.toHaveBeenCalled()

    readyGate.resolve(undefined)
    await session.ready
    await vi.waitFor(() => {
      expect(view.view.webContents.send).toHaveBeenCalledWith(
        'simulator:relaunch',
        expect.objectContaining({ url: expect.stringContaining('watch-ready') }),
      )
    })
    expect(view.view.webContents.send).toHaveBeenCalledTimes(1)

    await runtime.dispose()
  })
})
