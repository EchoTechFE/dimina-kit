/**
 * Contract tests for `SimulatorMiniApp.onSessionEvent` — a session-scoped
 * variant of `onSimulatorEvent`.
 *
 * During soft reload two SimulatorMiniApp instances (two app sessions) can be
 * alive at once: the current one and a background pending one. Main's
 * broadcast events (API_CALL, NAV_ACTION, …) reach BOTH sessions' shells over
 * the shared native-host bridge. Without session scoping, a request meant for
 * the pending session would also fire on the current session's handler (e.g.
 * a double `wx.request`).
 *
 * `onSessionEvent` fixes that: a payload carrying an `appSessionId` field is
 * only delivered to a listener whose owning instance's OWN spawned
 * `appSessionId` matches it. A payload with no `appSessionId` field at all is
 * unscoped and passes through to every listener, same as `onSimulatorEvent`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SimulatorMiniApp } from './simulator-mini-app'

type Listener = (payload: unknown) => void

interface SpawnResultStub {
  appSessionId: string
  bridgeId: string
  pagePath: string
  serviceWcId: number
  resourceBaseUrl: string
  manifest: { pages: string[]; entryPagePath: string }
  rootWindowConfig: Record<string, unknown>
}

function installNativeHostMock() {
  const listeners = new Map<string, Set<Listener>>()
  let spawnCount = 0

  const host = {
    enabled: true,
    device: undefined,
    spawn: async (): Promise<SpawnResultStub> => {
      spawnCount += 1
      const n = spawnCount
      return {
        appSessionId: `s${n}`,
        bridgeId: `b${n}`,
        pagePath: 'pages/index/index',
        serviceWcId: n,
        resourceBaseUrl: '',
        manifest: { pages: ['pages/index/index'], entryPagePath: 'pages/index/index' },
        rootWindowConfig: {},
      }
    },
    dispose: () => {},
    openPage: async () => ({ bridgeId: 'unused', pagePath: 'unused', windowConfig: {}, isTab: false }),
    closePage: () => {},
    notifyLifecycle: () => {},
    notifyNavCallback: () => {},
    notifyApiResponse: () => {},
    notifyActivePage: () => {},
    notifyPageStack: () => {},
    createRenderHostUrl: () => 'about:blank',
    renderPreloadUrl: 'about:blank',
    onSimulatorEvent: (channel: string, listener: Listener) => {
      let set = listeners.get(channel)
      if (!set) {
        set = new Set()
        listeners.set(channel, set)
      }
      set.add(listener)
      return () => { set!.delete(listener) }
    },
  }

  window.__diminaNativeHost = host as unknown as Window['__diminaNativeHost']

  return {
    fire(channel: string, payload: unknown) {
      const set = listeners.get(channel)
      for (const fn of [...(set ?? [])]) fn(payload)
    },
  }
}

async function bootMiniApp(): Promise<SimulatorMiniApp> {
  const miniApp = new SimulatorMiniApp({
    appId: 'test-app',
    scene: 1001,
    pagePath: 'pages/index/index',
  })
  await miniApp.spawn()
  return miniApp
}

afterEach(() => {
  delete (window as { __diminaNativeHost?: unknown }).__diminaNativeHost
})

const CHANNEL = 'simulator:api-call'

describe('SimulatorMiniApp.onSessionEvent — session-scoped event filtering', () => {
  it('delivers a payload whose appSessionId matches this instance’s spawned session', async () => {
    const { fire } = installNativeHostMock()
    const miniApp = await bootMiniApp() // appSessionId = 's1'
    const listener = vi.fn()
    miniApp.onSessionEvent(CHANNEL, listener)

    fire(CHANNEL, { appSessionId: 's1', name: 'getSystemInfo' })

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith({ appSessionId: 's1', name: 'getSystemInfo' })
  })

  it('drops a payload whose appSessionId belongs to a different overlapping session', async () => {
    const { fire } = installNativeHostMock()
    const miniAppA = await bootMiniApp() // 's1' — the current session
    const miniAppB = await bootMiniApp() // 's2' — a soft-reload pending session
    const listenerA = vi.fn()
    miniAppA.onSessionEvent(CHANNEL, listenerA)

    fire(CHANNEL, { appSessionId: 's2', name: 'getSystemInfo' })

    expect(listenerA).not.toHaveBeenCalled()
    void miniAppB
  })

  it('delivers a payload with no appSessionId field (unscoped broadcast)', async () => {
    const { fire } = installNativeHostMock()
    const miniApp = await bootMiniApp()
    const listener = vi.fn()
    miniApp.onSessionEvent(CHANNEL, listener)

    fire(CHANNEL, { name: 'deviceChangeLike' })

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith({ name: 'deviceChangeLike' })
  })

  it('the returned unsubscribe function stops delivering matching payloads', async () => {
    const { fire } = installNativeHostMock()
    const miniApp = await bootMiniApp()
    const listener = vi.fn()
    const unsubscribe = miniApp.onSessionEvent(CHANNEL, listener)

    unsubscribe()
    fire(CHANNEL, { appSessionId: 's1', name: 'getSystemInfo' })

    expect(listener).not.toHaveBeenCalled()
  })
})
