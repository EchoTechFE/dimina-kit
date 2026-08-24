/**
 * `AppManifest.entryPagePath` must name the APP's own home page, never the
 * page a particular spawn happened to request.
 *
 * The dimina compiler's `app-config.json` carries `app.pages` but frequently
 * omits `app.entryPagePath`. When the manifest falls back to the spawn's
 * requested page in that case, launching straight into an inner page makes
 * "current page === home page" trivially true, so anything keyed on the entry
 * page (the navigation bar's back-to-home rule) is dead for that session.
 *
 * The contract: whenever the compiled page list is present, the entry page is
 * `app.entryPagePath` if declared and `pages[0]` otherwise. Only a fallback
 * manifest — built when app-config.json is unreachable and there is no
 * compiled page list at all — may name the requested page.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createConnectionRegistry } from '@dimina-kit/electron-deck/main'

const stubs = vi.hoisted(() => {
  type AnyFn = (...args: unknown[]) => unknown
  type EventBag = Record<string, Set<AnyFn>>

  const invokeHandlers = new Map<string, AnyFn>()

  function makeEmitter() {
    const listeners: EventBag = {}
    const api = {
      listeners,
      on(event: string, fn: AnyFn) { (listeners[event] ??= new Set()).add(fn); return api },
      once(event: string, fn: AnyFn) {
        const wrap: AnyFn = (...a: unknown[]) => { listeners[event]?.delete(wrap); return fn(...a) }
        ;(listeners[event] ??= new Set()).add(wrap); return api
      },
      off(event: string, fn: AnyFn) { listeners[event]?.delete(fn); return api },
      removeListener(event: string, fn: AnyFn) { listeners[event]?.delete(fn); return api },
      emit(event: string, ...a: unknown[]) { for (const fn of [...(listeners[event] ?? [])]) fn(...a) },
    }
    return api
  }

  let nextWcId = 9000

  function makeWebContents() {
    const em = makeEmitter()
    return {
      ...em,
      id: nextWcId++,
      isDestroyed() { return false },
      getURL: () => 'file:///service.html',
      getType: () => 'window',
      send: vi.fn(),
      executeJavaScript: vi.fn(() => Promise.resolve(undefined)),
      openDevTools: vi.fn(),
    }
  }

  function makeBrowserWindow() {
    const em = makeEmitter()
    return {
      ...em,
      webContents: makeWebContents(),
      isDestroyed() { return false },
      close: vi.fn(),
      loadURL: vi.fn(() => Promise.resolve()),
      loadFile: vi.fn(() => Promise.resolve()),
    }
  }

  function reset() {
    invokeHandlers.clear()
    nextWcId = 9000
  }

  return { invokeHandlers, makeWebContents, makeBrowserWindow, reset }
})

vi.mock('electron', () => {
  type AnyFn = (...args: unknown[]) => unknown

  const ipcMain = {
    on: vi.fn(),
    removeListener: vi.fn(),
    handle: vi.fn((channel: string, fn: AnyFn) => { stubs.invokeHandlers.set(channel, fn) }),
    removeHandler: vi.fn((channel: string) => { stubs.invokeHandlers.delete(channel) }),
  }

  return {
    ipcMain,
    app: { isPackaged: true, getLocale: () => 'en-US', getPath: vi.fn(() => '/tmp/dimina-runtime-test') },
    BrowserWindow: class {},
    WebContentsView: class { webContents = {}; setBounds = vi.fn(); setBackgroundColor = vi.fn() },
    protocol: { handle: vi.fn(), unhandle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
    session: {
      fromPartition: vi.fn(() => ({
        webRequest: { onBeforeSendHeaders: vi.fn(), onHeadersReceived: vi.fn() },
        registerPreloadScript: vi.fn(),
        protocol: { handle: vi.fn(), unhandle: vi.fn() },
      })),
      defaultSession: { protocol: { handle: vi.fn(), unhandle: vi.fn() } },
    },
    webContents: { fromId: vi.fn(() => null), getAllWebContents: vi.fn(() => []) },
    nativeTheme: { themeSource: 'system', on: vi.fn() },
    default: {},
  }
})

vi.mock('@dimina-kit/electron-runtime/main/service-host-window', () => ({
  serviceHostSpec: () => ({}),
  serviceHostPreloadPath: '/tmp/preload.cjs',
  SERVICE_HOST_PARTITION: 'persist:simulator',
  buildServiceHostSpawnUrl: () => 'file:///service.html',
  navigateServiceHost: vi.fn(() => Promise.resolve()),
  createServiceHostWindow: vi.fn(() => stubs.makeBrowserWindow()),
  constructServiceHostWindow: vi.fn(() => stubs.makeBrowserWindow()),
}))

import { BRIDGE_CHANNELS as C } from '../../shared/bridge-channels.js'
import type { PageWindowConfig, SpawnRequest, SpawnResult, TabBarConfig } from '../../shared/bridge-channels.js'
import type { WorkbenchContext } from '../services/workbench-context.js'

type AnyFn = (...args: unknown[]) => unknown
type MockWc = ReturnType<typeof stubs.makeWebContents>

const APP_ID = 'test-app'
const ENTRY_PAGE = 'pages/index/index'
const SECOND_PAGE = 'pages/second/second'
const INNER_PAGE = 'pages/detail/detail'

let installBridgeRouter: typeof import('./bridge-router.js').installBridgeRouter
let originalFetch: typeof globalThis.fetch

beforeEach(async () => {
  vi.resetModules()
  stubs.reset()
  originalFetch = globalThis.fetch
  ;({ installBridgeRouter } = await import('./bridge-router.js'))
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

interface AppConfigFixture {
  entryPagePath?: string
  pages?: string[]
  tabBar?: TabBarConfig
  window?: Partial<PageWindowConfig>
}

/** Serves `fixture` as app-config.json, or a 404 when it is null. */
function installFetchMock(fixture: AppConfigFixture | null): void {
  globalThis.fetch = vi.fn((input: string | URL | Request) => {
    const href = typeof input === 'string' ? input
      : input instanceof URL ? input.href
      : (input as Request).url
    if (href.includes('app-config.json')) {
      if (!fixture) {
        return Promise.resolve({ ok: false, status: 404, json: async () => ({}), text: async () => '' } as unknown as Response)
      }
      const body = {
        app: {
          entryPagePath: fixture.entryPagePath,
          pages: fixture.pages,
          tabBar: fixture.tabBar,
          window: fixture.window,
        },
      }
      return Promise.resolve({
        ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body),
      } as unknown as Response)
    }
    return Promise.resolve({ ok: true, status: 200, text: async () => '', json: async () => ({}) } as unknown as Response)
  }) as unknown as typeof fetch
}

function makeCtx(): { ctx: WorkbenchContext; simulatorWc: MockWc } {
  const simulatorWc = stubs.makeWebContents()
  const ctx = {
    registry: { add: (_fn: AnyFn) => {} },
    simulatorApis: { has: (_name: string) => false, invoke: async () => ({}), list: () => [] },
    windows: { mainWindow: { webContents: simulatorWc } },
    workspace: { getSession: () => undefined, getProjectPath: () => '/tmp/dimina-project', isClosing: () => false },
    connections: createConnectionRegistry(),
  } as unknown as WorkbenchContext
  return { ctx, simulatorWc }
}

async function spawnSession(simulatorWc: MockWc, pagePath: string): Promise<SpawnResult> {
  const handle = stubs.invokeHandlers.get(C.SPAWN)
  if (!handle) throw new Error('SPAWN handler not registered')
  const req: SpawnRequest = { appId: APP_ID, pagePath, resourceBaseUrl: 'http://127.0.0.1:1/' }
  return (await (handle as AnyFn)({ sender: simulatorWc }, req)) as SpawnResult
}

describe('buildAppManifest — entryPagePath is the app home page, not the launch request', () => {
  it('keeps the declared entryPagePath when the launch request is a different page', async () => {
    installFetchMock({ entryPagePath: ENTRY_PAGE, pages: [ENTRY_PAGE, SECOND_PAGE, INNER_PAGE] })
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)

    const result = await spawnSession(simulatorWc, INNER_PAGE)

    expect(result.manifest.entryPagePath).toBe(ENTRY_PAGE)
  })

  it('uses pages[0] when app-config.json declares a page list but no entryPagePath', async () => {
    // The compiler's app-config.json commonly carries only pages/window/tabBar.
    installFetchMock({ pages: [ENTRY_PAGE, SECOND_PAGE, INNER_PAGE] })
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)

    const result = await spawnSession(simulatorWc, INNER_PAGE)

    expect(result.manifest.entryPagePath).toBe(ENTRY_PAGE)
    expect(result.manifest.entryPagePath).not.toBe(INNER_PAGE)
  })

  it('normalizes a pages[0] that carries a leading slash', async () => {
    installFetchMock({ pages: [`/${ENTRY_PAGE}`, SECOND_PAGE] })
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)

    const result = await spawnSession(simulatorWc, SECOND_PAGE)

    expect(result.manifest.entryPagePath).toBe(ENTRY_PAGE)
  })

  it('reports the same entry page no matter which page the session launched into', async () => {
    installFetchMock({ pages: [ENTRY_PAGE, SECOND_PAGE, INNER_PAGE] })
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)

    const fromEntry = await spawnSession(simulatorWc, ENTRY_PAGE)
    const fromInner = await spawnSession(simulatorWc, INNER_PAGE)
    const fromSecond = await spawnSession(simulatorWc, SECOND_PAGE)

    expect(fromInner.manifest.entryPagePath).toBe(fromEntry.manifest.entryPagePath)
    expect(fromSecond.manifest.entryPagePath).toBe(fromEntry.manifest.entryPagePath)
  })

  it('falls back to pages[0] when the declared entryPagePath is not one of the pages', async () => {
    // A page deleted without updating app.json leaves entryPagePath pointing at
    // nothing the session can ever load.
    installFetchMock({ entryPagePath: 'pages/gone/gone', pages: [ENTRY_PAGE, INNER_PAGE] })
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)

    const result = await spawnSession(simulatorWc, ENTRY_PAGE)

    expect(result.manifest.entryPagePath).toBe(ENTRY_PAGE)
  })

  it('names the requested page only for a fallback manifest with no compiled page list', async () => {
    installFetchMock(null)
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)

    const result = await spawnSession(simulatorWc, INNER_PAGE)

    expect(result.manifest.source).toBe('fallback')
    expect(result.manifest.entryPagePath).toBe(INNER_PAGE)
  })
})
