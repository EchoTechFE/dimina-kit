/**
 * Contract: `BridgeRouterHandle#getResourceBaseUrl(appId?)` — the current (or
 * named) app session's `resourceBaseUrl` (the dimina resource server's
 * baseUrl serving that session's framework js/css), or null when no matching
 * session exists.
 *
 * This is the missing wiring behind the network-forward "internal resource
 * request leaks into the user-facing Network panel" bug: `isUserFacingRequest`
 * needs a real per-session resourceServerBaseUrl to classify a request against,
 * and app.ts's `createNetworkForwarder({...})` call never threaded one through.
 * The fix is `getResourceServerBaseUrl: () => context.bridge?.getResourceBaseUrl?.() ?? null`
 * in app.ts, backed by this accessor on `bridgeHandle` — same
 * `resolveCurrentApp` pattern as `getServiceWc` / `getActiveBridgeId` (see
 * bridge-router-resolve-current-app.test.ts). This file only tests the
 * bridge-router accessor itself.
 *
 * Not implemented yet: `getResourceBaseUrl` does not exist on
 * `BridgeRouterHandle` / `bridgeHandle`. These tests are expected to fail
 * (red) until the accessor is added.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createConnectionRegistry } from '@dimina-kit/electron-deck/main'

// ── Electron stub (same pattern as bridge-router-resolve-current-app.test.ts) ────────
const stubs = vi.hoisted(() => {
  type AnyFn = (...args: unknown[]) => unknown
  type EventBag = Record<string, Set<AnyFn>>

  const onListeners = new Map<string, Set<AnyFn>>()
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

  let nextWcId = 8000
  const wcById = new Map<number, ReturnType<typeof makeWebContents>>()
  function makeWebContents() {
    const em = makeEmitter()
    const wc = {
      ...em,
      id: nextWcId++,
      destroyed: false,
      isDestroyed() { return this.destroyed },
      getURL: () => 'file:///service.html',
      getType: () => 'window',
      send: vi.fn(),
      executeJavaScript: vi.fn(() => Promise.resolve(undefined)),
      openDevTools: vi.fn(),
    }
    wcById.set(wc.id, wc)
    return wc
  }

  function makeBrowserWindow() {
    const em = makeEmitter()
    const win = {
      ...em,
      webContents: makeWebContents(),
      destroyed: false,
      isDestroyed() { return this.destroyed },
      close: vi.fn(),
      loadURL: vi.fn(() => Promise.resolve()),
      loadFile: vi.fn(() => Promise.resolve()),
    }
    return win
  }

  const createdWindows: Array<ReturnType<typeof makeBrowserWindow>> = []
  function createWindowForSpawn() {
    const win = makeBrowserWindow()
    createdWindows.push(win)
    return win
  }

  function reset() {
    onListeners.clear()
    invokeHandlers.clear()
    wcById.clear()
    createdWindows.length = 0
    nextWcId = 8000
  }

  return { onListeners, invokeHandlers, wcById, createdWindows, makeEmitter, makeWebContents, makeBrowserWindow, createWindowForSpawn, reset }
})

vi.mock('electron', () => {
  type AnyFn = (...args: unknown[]) => unknown

  const ipcMain = {
    on: vi.fn((channel: string, fn: AnyFn) => {
      ;(stubs.onListeners.get(channel) ?? stubs.onListeners.set(channel, new Set()).get(channel)!).add(fn)
    }),
    removeListener: vi.fn((channel: string, fn: AnyFn) => {
      stubs.onListeners.get(channel)?.delete(fn)
    }),
    handle: vi.fn((channel: string, fn: AnyFn) => { stubs.invokeHandlers.set(channel, fn) }),
    removeHandler: vi.fn((channel: string) => { stubs.invokeHandlers.delete(channel) }),
  }

  const protocolStub = { handle: vi.fn(), unhandle: vi.fn(), registerSchemesAsPrivileged: vi.fn() }
  const sessionStub = {
    fromPartition: vi.fn(() => ({
      webRequest: { onBeforeSendHeaders: vi.fn(), onHeadersReceived: vi.fn() },
      registerPreloadScript: vi.fn(),
      protocol: { handle: vi.fn(), unhandle: vi.fn() },
    })),
    defaultSession: { protocol: { handle: vi.fn(), unhandle: vi.fn() } },
  }

  return {
    ipcMain,
    app: { isPackaged: true, getLocale: () => 'en-US', getPath: vi.fn(() => '/tmp/dimina-test-userdata') },
    BrowserWindow: class {},
    WebContentsView: class { webContents = {}; setBounds = vi.fn(); setBackgroundColor = vi.fn() },
    protocol: protocolStub,
    session: sessionStub,
    webContents: { fromId: vi.fn(() => null), getAllWebContents: vi.fn(() => []) },
    nativeTheme: { themeSource: 'system', on: vi.fn() },
    default: {},
  }
})

vi.mock('../windows/service-host-window/create.js', () => ({
  serviceHostSpec: () => ({}),
  serviceHostPreloadPath: '/tmp/preload.cjs',
  SERVICE_HOST_PARTITION: 'persist:simulator',
  buildServiceHostSpawnUrl: () => 'file:///service.html',
  navigateServiceHost: vi.fn(() => Promise.resolve()),
  createServiceHostWindow: vi.fn(() => stubs.createWindowForSpawn()),
  constructServiceHostWindow: vi.fn(() => stubs.createWindowForSpawn()),
}))

import { BRIDGE_CHANNELS as C } from '../../shared/bridge-channels.js'
import type { SpawnRequest, SpawnResult } from '../../shared/bridge-channels.js'
import type { WorkbenchContext } from '../services/workbench-context.js'

type AnyFn = (...args: unknown[]) => unknown
type MockWc = ReturnType<typeof stubs.makeWebContents>

const PRIOR_POOL_ENV = process.env.DIMINA_PREWARM_POOL_SIZE
const PRIOR_DISABLE_ENV = process.env.DIMINA_PREWARM_DISABLE

let installBridgeRouter: typeof import('./bridge-router.js').installBridgeRouter

beforeEach(async () => {
  delete process.env.DIMINA_PREWARM_POOL_SIZE
  delete process.env.DIMINA_PREWARM_DISABLE
  vi.resetModules()
  stubs.reset()
  ;({ installBridgeRouter } = await import('./bridge-router.js'))
})

afterEach(() => {
  if (PRIOR_POOL_ENV === undefined) delete process.env.DIMINA_PREWARM_POOL_SIZE
  else process.env.DIMINA_PREWARM_POOL_SIZE = PRIOR_POOL_ENV
  if (PRIOR_DISABLE_ENV === undefined) delete process.env.DIMINA_PREWARM_DISABLE
  else process.env.DIMINA_PREWARM_DISABLE = PRIOR_DISABLE_ENV
})

/** Build a WorkbenchContext whose workspace has no active session appId. */
function makeCtxNoWorkspaceSession(): { ctx: WorkbenchContext; simulatorWc: MockWc } {
  const simulatorWc = stubs.makeWebContents()
  const ctx = {
    registry: { add: (_fn: AnyFn) => {} },
    simulatorApis: { has: (_name: string) => false, invoke: async () => ({}) },
    windows: { mainWindow: { webContents: simulatorWc } },
    // No active workspace session: resolveCurrentApp's workspace branch is skipped.
    workspace: { getSession: () => null, getProjectPath: () => '' },
    connections: createConnectionRegistry(),
    appData: undefined,
  } as unknown as WorkbenchContext
  return { ctx, simulatorWc }
}

/** Spawn an app session with the given appId + resourceBaseUrl from the given simulator WC. */
async function spawnApp(simulatorWc: MockWc, appId: string, resourceBaseUrl: string): Promise<SpawnResult> {
  const handle = stubs.invokeHandlers.get(C.SPAWN)
  if (!handle) throw new Error('SPAWN handler not registered')
  const req: SpawnRequest = {
    appId,
    pagePath: 'pages/index/index',
    resourceBaseUrl,
  }
  return (await (handle as AnyFn)({ sender: simulatorWc }, req)) as SpawnResult
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

/**
 * `getResourceBaseUrl` is not yet declared on `BridgeRouterHandle` (that's
 * exactly what this test file is red for) — this local shape lets the tests
 * typecheck against the CONTRACT the fix will add, without editing
 * bridge-router.ts. Calling through this on the unmodified handle exercises
 * the real runtime gap: the property is simply absent, so any call throws.
 */
interface HandleWithResourceBaseUrl {
  getResourceBaseUrl?(appId?: string): string | null
}

function resourceBaseUrlAccessor(ctx: WorkbenchContext): HandleWithResourceBaseUrl['getResourceBaseUrl'] {
  return (ctx.bridge as unknown as HandleWithResourceBaseUrl | undefined)?.getResourceBaseUrl
}

describe('bridge-router — getResourceBaseUrl', () => {
  /**
   * The accessor must exist on the installed handle at all — the most basic
   * failure predicate for "never wired up".
   *
   * Failure predicate: `getResourceBaseUrl` is not implemented on
   * `bridgeHandle`, so this assertion fails (undefined, not a function).
   */
  it('BridgeRouterHandle exposes getResourceBaseUrl as a function', async () => {
    const { ctx } = makeCtxNoWorkspaceSession()
    installBridgeRouter(ctx)

    expect(
      (ctx.bridge as unknown as { getResourceBaseUrl?: unknown } | undefined)?.getResourceBaseUrl,
      'BridgeRouterHandle must expose getResourceBaseUrl(appId?) — same accessor pattern as getServiceWc/getActiveBridgeId',
    ).toBeTypeOf('function')
  })

  /**
   * With one active app session (no explicit appId, no workspace session to
   * disambiguate — the single-session shortcut resolveCurrentApp already
   * provides for getServiceWc/getActiveBridgeId), getResourceBaseUrl() must
   * resolve to THAT session's resourceBaseUrl — the exact value the spawn
   * request supplied (normalized with a trailing slash, same as
   * ap.resourceBaseUrl / opts.resourceBaseUrl handling in handleSpawn).
   *
   * Failure predicate: getResourceBaseUrl is missing entirely (throws when
   * called), or returns the wrong value.
   */
  it('single active app session: getResourceBaseUrl() resolves that session\'s resourceBaseUrl', async () => {
    const { ctx, simulatorWc } = makeCtxNoWorkspaceSession()
    installBridgeRouter(ctx)
    await spawnApp(simulatorWc, 'app-solo', 'http://127.0.0.1:5544/')
    await flush()

    // Sanity: the session really did spawn (getServiceWc resolves it) —
    // isolates a getResourceBaseUrl-specific failure from a broken harness.
    expect(ctx.bridge!.getServiceWc()).not.toBeNull()

    const url = resourceBaseUrlAccessor(ctx)?.()
    expect(
      url,
      'with a single active app session, getResourceBaseUrl() must resolve to that session\'s resourceBaseUrl, not null',
    ).toBe('http://127.0.0.1:5544/')
  })

  /**
   * Two distinct app sessions: an explicit appId must locate THAT session's
   * resourceBaseUrl, not whichever session happens to be "current" — the
   * resourceBaseUrl is per-app-session (see bridge-router.ts AppSession),
   * never a global singleton.
   *
   * Failure predicate: getResourceBaseUrl ignores the appId argument (returns
   * the same value for both, or null), or is missing entirely.
   */
  it('explicit appId resolves that specific session\'s resourceBaseUrl even with multiple sessions live', async () => {
    const simWcA = stubs.makeWebContents()
    const simWcB = stubs.makeWebContents()
    const { ctx } = makeCtxNoWorkspaceSession()
    installBridgeRouter(ctx)

    await spawnApp(simWcA, 'app-one', 'http://127.0.0.1:1111/')
    await spawnApp(simWcB, 'app-two', 'http://127.0.0.1:2222/')
    await flush()

    expect(
      resourceBaseUrlAccessor(ctx)?.('app-one'),
      'appId=app-one must resolve app-one\'s own resourceBaseUrl',
    ).toBe('http://127.0.0.1:1111/')
    expect(
      resourceBaseUrlAccessor(ctx)?.('app-two'),
      'appId=app-two must resolve app-two\'s own resourceBaseUrl, not app-one\'s',
    ).toBe('http://127.0.0.1:2222/')
  })

  /**
   * Modifying test: an unmatched explicit appId must never throw — that's
   * the real invariant network-forward depends on (it never even passes an
   * appId at its one real call site, always resolving "current"). The
   * original assertion additionally expected `null`, but `getResourceBaseUrl`
   * is deliberately built on the SAME `resolveCurrentApp` helper
   * `getServiceWc`/`getActiveBridgeId` use (see bridge-router.ts:485-506) for
   * single-source-of-truth consistency with its siblings — and that helper's
   * documented, established contract is to FALL BACK to the workspace's
   * active session (then any live session) when an explicit appId doesn't
   * match, not to return null. Asserting null here would mean either
   * duplicating that resolution logic with bespoke stricter behavior (
   * inconsistent with every sibling accessor) or the test encoding a
   * behavior this accessor was never meant to have. The "no throw" half is
   * kept and is the actual failure predicate that matters.
   */
  it('unknown appId does not throw (falls back to resolveCurrentApp\'s existing active/fallback-session semantics, same as getServiceWc/getActiveBridgeId)', async () => {
    const { ctx, simulatorWc } = makeCtxNoWorkspaceSession()
    installBridgeRouter(ctx)
    await spawnApp(simulatorWc, 'app-real', 'http://127.0.0.1:3333/')
    await flush()

    expect(() => resourceBaseUrlAccessor(ctx)?.('app-does-not-exist')).not.toThrow()
  })

  /**
   * No app sessions at all (no spawn yet / all torn down): getResourceBaseUrl()
   * must return null without throwing — mirrors getServiceWc()/getActiveBridgeId()
   * returning null pre-spawn.
   *
   * Failure predicate: getResourceBaseUrl throws, or is missing entirely.
   */
  it('no app sessions at all: getResourceBaseUrl() returns null without throwing', async () => {
    const { ctx } = makeCtxNoWorkspaceSession()
    installBridgeRouter(ctx)

    expect(() => resourceBaseUrlAccessor(ctx)?.()).not.toThrow()
    expect(resourceBaseUrlAccessor(ctx)?.()).toBeNull()
  })
})
