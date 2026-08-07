/**
 * `SimulatorMiniApp.getHomePagePath()` — the app's own entry page, the value
 * the navigation bar's home-button rule compares the current page against.
 *
 * It reads the compiled manifest: `entryPagePath` is authoritative, `pages[0]`
 * stands in when the compiler emitted no explicit entry, and an empty string
 * means "unknown" so callers can disable the rule instead of guessing a page.
 *
 * Only an `'app-config'` manifest can name a home page. A `'fallback'` manifest
 * is built when app-config.json is unreachable, and its `entryPagePath` is the
 * page THIS launch requested — accepting it would let a deep-linked inner page
 * pose as the app's home page, so a fallback manifest reports "unknown".
 */
import { afterEach, describe, expect, it } from 'vitest'
import { SimulatorMiniApp } from './simulator-mini-app'

type Listener = (payload: unknown) => void

interface ManifestStub {
  pages: string[]
  entryPagePath: string
  source: 'app-config' | 'fallback'
}

function installNativeHostMock(manifest: ManifestStub) {
  const host = {
    enabled: true,
    device: undefined,
    spawn: async (opts: { pagePath: string }) => ({
      appSessionId: 's1',
      bridgeId: 'b1',
      pagePath: opts.pagePath,
      resolvedPagePath: opts.pagePath,
      pageFallbackApplied: false,
      serviceWcId: 1,
      resourceBaseUrl: '',
      root: 'main',
      manifest,
      rootWindowConfig: {},
    }),
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
    onSimulatorEvent: (_channel: string, _listener: Listener) => () => {},
  }
  window.__diminaNativeHost = host as unknown as Window['__diminaNativeHost']
}

afterEach(() => {
  delete (window as { __diminaNativeHost?: unknown }).__diminaNativeHost
})

const ENTRY_PAGE = 'pages/home/home'
const FIRST_PAGE = 'pages/first/first'
const START_PAGE = 'pages/detail/detail'

async function bootWith(manifest: ManifestStub): Promise<SimulatorMiniApp> {
  installNativeHostMock(manifest)
  const miniApp = new SimulatorMiniApp({ appId: 'test-app', scene: 1001, pagePath: START_PAGE })
  await miniApp.spawn()
  return miniApp
}

describe('SimulatorMiniApp.getHomePagePath', () => {
  it('reports manifest.entryPagePath even when another page leads the pages list', async () => {
    const miniApp = await bootWith({
      pages: [FIRST_PAGE, ENTRY_PAGE, START_PAGE],
      entryPagePath: ENTRY_PAGE,
      source: 'app-config',
    })
    expect(miniApp.getHomePagePath()).toBe(ENTRY_PAGE)
  })

  it('falls back to the first compiled page when no entry page is declared', async () => {
    const miniApp = await bootWith({
      pages: [FIRST_PAGE, START_PAGE],
      entryPagePath: '',
      source: 'app-config',
    })
    expect(miniApp.getHomePagePath()).toBe(FIRST_PAGE)
  })

  it('reports an unknown home page when a compiled manifest names neither', async () => {
    const miniApp = await bootWith({ pages: [], entryPagePath: '', source: 'app-config' })
    expect(miniApp.getHomePagePath()).toBe('')
  })

  it('reports an unknown home page for a fallback manifest, whose entry is the launch request', async () => {
    // The shape buildAppManifest actually produces when app-config.json is
    // unreachable: a single-page manifest whose entry IS the requested page.
    const miniApp = await bootWith({
      pages: [START_PAGE],
      entryPagePath: START_PAGE,
      source: 'fallback',
    })
    expect(miniApp.getHomePagePath()).toBe('')
    expect(miniApp.getHomePagePath()).not.toBe(START_PAGE)
  })

  it('reports an unknown home page before a session has been spawned', () => {
    const miniApp = new SimulatorMiniApp({ appId: 'test-app', scene: 1001, pagePath: START_PAGE })
    expect(miniApp.getHomePagePath()).toBe('')
  })

  it('reports an unknown home page again after the session is disposed', async () => {
    const miniApp = await bootWith({
      pages: [ENTRY_PAGE],
      entryPagePath: ENTRY_PAGE,
      source: 'app-config',
    })
    expect(miniApp.getHomePagePath()).toBe(ENTRY_PAGE)
    miniApp.dispose()
    expect(miniApp.getHomePagePath()).toBe('')
  })
})
