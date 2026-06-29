/**
 * Contract: resolveCurrentApp (the internal function behind getServiceWc /
 * getActiveRenderWc / getActiveBridgeId with no appId argument) must
 * disambiguate based on the workspace active session, and fall back to the
 * single-session shortcut ONLY when there is exactly one appId in state.
 *
 * Two tightened behaviours:
 *
 *   1. Multiple distinct appIds in state + no workspace session → return null.
 *      The current implementation returns the last-inserted session, which is
 *      non-deterministic when a project is switching and two apps overlap. A
 *      null answer forces callers to supply an explicit appId.
 *
 *   2. Exactly one appId → still resolves (single-session shortcut preserved).
 *
 * The same-appId many-spawns rule (most-recent spawn wins) is already covered
 * by bridge-router-simulator-destroyed.test.ts (3); we must not break it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createConnectionRegistry } from '@dimina-kit/electron-deck/main'

// ── Electron stub (same pattern as bridge-router-simulator-destroyed) ────────
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

  let nextWcId = 7000
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
    nextWcId = 7000
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

/** Spawn an app session with the given appId from the given simulator WC. */
async function spawnApp(simulatorWc: MockWc, appId: string): Promise<SpawnResult> {
  const handle = stubs.invokeHandlers.get(C.SPAWN)
  if (!handle) throw new Error('SPAWN handler not registered')
  const req: SpawnRequest = {
    appId,
    pagePath: 'pages/index/index',
    resourceBaseUrl: 'http://127.0.0.1:1/',
  }
  return (await (handle as AnyFn)({ sender: simulatorWc }, req)) as SpawnResult
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('bridge-router — resolveCurrentApp with no workspace session', () => {
  /**
   * Single session: when there is exactly one appId in state and no workspace
   * session to disambiguate, the single-session shortcut resolves it. This is
   * the existing "lone app" path that must not be broken by the multi-app guard.
   *
   * Failure predicate: if the refactor incorrectly guards the single-session
   * case, getServiceWc() returns null and this test fails.
   */
  it('single appId in state → getServiceWc() resolves without an explicit appId', async () => {
    const { ctx, simulatorWc } = makeCtxNoWorkspaceSession()
    installBridgeRouter(ctx)
    const { serviceWcId } = await spawnApp(simulatorWc, 'app-solo')
    await flush()

    const wc = ctx.bridge!.getServiceWc()

    expect(
      wc,
      'with a single app session and no workspace session, getServiceWc() must resolve it',
    ).not.toBeNull()
    expect(wc!.id).toBe(serviceWcId)
  })

  /**
   * Multiple distinct appIds with no workspace session: the router cannot
   * determine which app the caller means, so getServiceWc() must return null
   * rather than silently returning an arbitrary (last-inserted) session.
   *
   * Failure predicate: the current implementation returns the last-inserted
   * session regardless of how many distinct appIds exist, so getServiceWc()
   * returns a non-null value — the assertion `toBeNull()` fails → red.
   */
  it('two distinct appIds in state + no workspace session → getServiceWc() returns null (ambiguous)', async () => {
    const simWcA = stubs.makeWebContents()
    const simWcB = stubs.makeWebContents()
    // Both share the same ctx — makeCtxNoWorkspaceSession creates one ctx; we
    // reuse it for both spawns since the test only needs the bridge handle.
    const { ctx } = makeCtxNoWorkspaceSession()
    installBridgeRouter(ctx)

    await spawnApp(simWcA, 'app-alpha')
    await spawnApp(simWcB, 'app-beta')
    await flush()

    const wc = ctx.bridge!.getServiceWc()

    expect(
      wc,
      'with two distinct appId sessions and no workspace session, getServiceWc() '
      + 'must return null — returning an arbitrary session is wrong-target content',
    ).toBeNull()
  })

  /**
   * Symmetric check: getActiveRenderWc() must also return null when there are
   * multiple distinct appIds and no workspace session. The render-guest WC is
   * used for thumbnail capture and WXML inspection — resolving the wrong guest
   * captures the wrong app's content.
   *
   * Failure predicate: current impl returns the render guest of the last-inserted
   * session (or null because no render bound yet) — but the contract is that null
   * is returned because ambiguous, not accidentally null because no render bound.
   * The test documents that the null is intentional even when a render WC IS bound.
   *
   * Note: render WC binding requires a RENDER_INVOKE from the render guest, which
   * is complex to drive here. We test the service-WC path above and document the
   * render-guest contract as the same (by symmetry of resolveCurrentApp).
   */
  it('two distinct appIds → getActiveBridgeId() returns null (no workspace session to pick)', async () => {
    const simWcA = stubs.makeWebContents()
    const simWcB = stubs.makeWebContents()
    const { ctx } = makeCtxNoWorkspaceSession()
    installBridgeRouter(ctx)

    await spawnApp(simWcA, 'app-gamma')
    await spawnApp(simWcB, 'app-delta')
    await flush()

    const bridgeId = ctx.bridge!.getActiveBridgeId()

    expect(
      bridgeId,
      'with two distinct appId sessions and no workspace session, getActiveBridgeId() '
      + 'must return null — returning an arbitrary session\'s bridgeId targets wrong content',
    ).toBeNull()
  })

  /**
   * Explicit appId always resolves the named session, even when multiple
   * distinct appIds are present. The multi-app guard only applies to the
   * no-appId (ambient) resolution path; callers that know their target must
   * still get a direct answer.
   *
   * Failure predicate: if the guard incorrectly blocks explicit-appId lookups
   * it would return null here — this test catches that regression.
   */
  it('explicit appId resolves correctly even when multiple distinct appIds coexist', async () => {
    const simWcA = stubs.makeWebContents()
    const simWcB = stubs.makeWebContents()
    const { ctx } = makeCtxNoWorkspaceSession()
    installBridgeRouter(ctx)

    const resultA = await spawnApp(simWcA, 'app-one')
    const resultB = await spawnApp(simWcB, 'app-two')
    await flush()

    const wcA = ctx.bridge!.getServiceWc('app-one')
    const wcB = ctx.bridge!.getServiceWc('app-two')

    expect(wcA, 'explicit appId=app-one must resolve to app-one\'s service WC').not.toBeNull()
    expect(wcA!.id).toBe(resultA.serviceWcId)

    expect(wcB, 'explicit appId=app-two must resolve to app-two\'s service WC').not.toBeNull()
    expect(wcB!.id).toBe(resultB.serviceWcId)
  })

  /**
   * Same appId, two spawns (respawn/hot-reload): the most-recent spawn wins.
   * This is the existing guarantee from bridge-router-simulator-destroyed.test.ts (3);
   * this test guards that the multi-app null-return guard does NOT break it —
   * two sessions with the SAME appId are not "multiple distinct appIds".
   *
   * Failure predicate: if the guard incorrectly counts same-appId sessions as
   * distinct, it returns null instead of the newest session → assertion fails.
   */
  it('same appId, two spawns: most-recent spawn still resolves (guard does not treat them as distinct)', async () => {
    const simWcOld = stubs.makeWebContents()
    const simWcNew = stubs.makeWebContents()
    const { ctx } = makeCtxNoWorkspaceSession()
    installBridgeRouter(ctx)

    await spawnApp(simWcOld, 'app-shared')
    const resultNew = await spawnApp(simWcNew, 'app-shared')
    await flush()

    const wc = ctx.bridge!.getServiceWc()

    expect(
      wc,
      'same-appId two spawns: most-recent must resolve even with no workspace session',
    ).not.toBeNull()
    expect(wc!.id).toBe(resultNew.serviceWcId)
  })
})
