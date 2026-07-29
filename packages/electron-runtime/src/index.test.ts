import { beforeEach, describe, expect, it, vi } from 'vitest'

const stubs = vi.hoisted(() => {
  let appReady = true
  let nextViewId = 1
  return {
    setAppReady(value: boolean) {
      appReady = value
    },
    isAppReady: () => appReady,
    registerSchemes: vi.fn(),
    createView: vi.fn(() => {
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
    }),
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
    ctx.bridge = {
      getServiceWc: () => null,
      setDevice: vi.fn(),
    }
  },
}))

vi.mock('./main/embedded-view.js', () => ({
  createEmbeddedMiniappView: stubs.createView,
}))

vi.mock('./main/services/simulator-temp-files/index.js', () => ({
  setupSimulatorTempFiles: () => ({ dispose: vi.fn() }),
}))

vi.mock('./main/services/views/simulator-session-policy.js', () => ({
  setupSimulatorSessionPolicy: () => ({ dispose: vi.fn() }),
}))

import {
  createElectronRuntime,
  registerElectronRuntimeSchemes,
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
    stubs.createView.mockClear()
  })

  it('registers its file/resource schemes before Electron readiness', () => {
    stubs.setAppReady(false)
    registerElectronRuntimeSchemes()
    expect(stubs.registerSchemes).toHaveBeenCalledOnce()
    expect(stubs.registerSchemes.mock.calls[0]?.[0]).toEqual(expect.arrayContaining([
      expect.objectContaining({ scheme: 'difile' }),
      expect.objectContaining({ scheme: 'dmb-resource' }),
    ]))
  })

  it('requires the host to wait for Electron app readiness', () => {
    stubs.setAppReady(false)
    expect(() => createElectronRuntime({
      hostWindow,
      adapter: { openProject: vi.fn() },
    })).toThrow(/after Electron app is ready/)
  })

  it('serializes project opens and an old session cannot dispose the new one', async () => {
    const first = deferred<ElectronRuntimeCompilerSession>()
    const second = deferred<ElectronRuntimeCompilerSession>()
    const closeA = vi.fn(async () => {})
    const closeB = vi.fn(async () => {})
    const openProject = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)

    const runtime = createElectronRuntime({
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
})
