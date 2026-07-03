/**
 * Guards `SimulatorMiniApp.spawn()`'s bookkeeping of the resolved root page.
 *
 * ── The bug being pinned (TDD red) ──────────────────────────────────────────
 * `handleSpawn` (main) now resolves a root pagePath absent from the compiled
 * manifest to a fallback page (`manifest.entryPagePath`, else `pages[0]`) and
 * reports the outcome on `SpawnResult` (`resolvedPagePath`,
 * `pageFallbackApplied`) instead of spawning a session for a page that was
 * never mountable (see the sibling `bridge-router-spawn-fallback` suite).
 *
 * `SimulatorMiniApp` still holds onto the pagePath it was CONSTRUCTED with
 * (`this.pagePath = opts.pagePath`) and never updates it from the spawn
 * result. When a fallback was applied, main's session was actually spawned
 * with `resolvedPagePath`, not the app's own `this.pagePath` — every
 * consumer that reads `miniApp.pagePath` afterward (persisted "resume last
 * page" state, page-stack bookkeeping, respawn-with-same-page logic) would be
 * silently wrong about which page is actually live.
 *
 * The fix: `spawn()` must overwrite `this.pagePath` with
 * `result.resolvedPagePath` once spawn settles, so it always reflects the
 * page the session was ACTUALLY spawned with.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { SimulatorMiniApp } from './simulator-mini-app'

type Listener = (payload: unknown) => void

interface SpawnResultStub {
  appSessionId: string
  bridgeId: string
  pagePath: string
  resolvedPagePath: string
  pageFallbackApplied: boolean
  serviceWcId: number
  resourceBaseUrl: string
  manifest: { pages: string[]; entryPagePath: string; source: 'app-config' | 'fallback' }
  rootWindowConfig: Record<string, unknown>
}

function installNativeHostMock(spawnResult: (requestedPagePath: string) => SpawnResultStub) {
  const listeners = new Map<string, Set<Listener>>()

  const host = {
    enabled: true,
    device: undefined,
    spawn: async (opts: { pagePath: string }): Promise<SpawnResultStub> => spawnResult(opts.pagePath),
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
      if (!set) { set = new Set(); listeners.set(channel, set) }
      set.add(listener)
      return () => { set!.delete(listener) }
    },
  }

  window.__diminaNativeHost = host as unknown as Window['__diminaNativeHost']
}

afterEach(() => {
  delete (window as { __diminaNativeHost?: unknown }).__diminaNativeHost
})

const REQUESTED_PAGE = 'pages/removed/removed'
const FALLBACK_PAGE = 'pages/index/index'

describe('SimulatorMiniApp.spawn — reconciles pagePath with the resolved root page', () => {
  it('overwrites this.pagePath with resolvedPagePath when main applied a fallback', async () => {
    installNativeHostMock(() => ({
      appSessionId: 's1',
      bridgeId: 'b1',
      pagePath: REQUESTED_PAGE,
      resolvedPagePath: FALLBACK_PAGE,
      pageFallbackApplied: true,
      serviceWcId: 1,
      resourceBaseUrl: '',
      manifest: { pages: [FALLBACK_PAGE], entryPagePath: FALLBACK_PAGE, source: 'app-config' },
      rootWindowConfig: {},
    }))

    const miniApp = new SimulatorMiniApp({ appId: 'test-app', scene: 1001, pagePath: REQUESTED_PAGE })
    await miniApp.spawn()

    expect(miniApp.pagePath).toBe(FALLBACK_PAGE)
    expect(miniApp.pagePath).not.toBe(REQUESTED_PAGE)
  })

  it('keeps this.pagePath equal to the request when no fallback was applied (no regression)', async () => {
    installNativeHostMock(() => ({
      appSessionId: 's1',
      bridgeId: 'b1',
      pagePath: FALLBACK_PAGE,
      resolvedPagePath: FALLBACK_PAGE,
      pageFallbackApplied: false,
      serviceWcId: 1,
      resourceBaseUrl: '',
      manifest: { pages: [FALLBACK_PAGE], entryPagePath: FALLBACK_PAGE, source: 'app-config' },
      rootWindowConfig: {},
    }))

    const miniApp = new SimulatorMiniApp({ appId: 'test-app', scene: 1001, pagePath: FALLBACK_PAGE })
    await miniApp.spawn()

    expect(miniApp.pagePath).toBe(FALLBACK_PAGE)
  })
})
