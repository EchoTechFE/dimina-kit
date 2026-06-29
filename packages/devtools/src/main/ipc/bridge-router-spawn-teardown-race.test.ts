/**
 * Regression tests for two concurrent-spawn contracts in handleSpawn:
 *
 * SPAWN-TEARDOWN RACE: An in-flight SPAWN whose simulatorWc is destroyed during
 * its awaits must not register a zombie session. The simulatorWc's 'destroyed'
 * event fires before the `simulatorWc.once('destroyed', …)` hook is installed,
 * so without the post-once `isDestroyed()` guard the freshly registered session
 * persists with no cleanup trigger — a zombie owned by a dead simulator.
 *
 * PARTITION PROJECTPATH CAPTURE: createServiceHostWindow receives the projectPath
 * captured at spawn ENTRY, not a value re-read after awaits. A project switch
 * mid-flight would otherwise give the new service host a different partition than
 * the simulator WCV was built with, splitting miniapp storage across sessions.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createConnectionRegistry } from '@dimina-kit/electron-deck/main'

// ── Hoisted stubs ────────────────────────────────────────────────────────────
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

  let nextWcId = 4000
  const wcById = new Map<number, ReturnType<typeof makeWebContents>>()

  function makeWebContents() {
    const em = makeEmitter()
    const sent: Array<{ channel: string; payload: unknown }> = []
    const wc = {
      ...em,
      id: nextWcId++,
      destroyed: false,
      isDestroyed() { return this.destroyed },
      getURL: () => 'file:///service.html',
      getType: () => 'window',
      send: vi.fn((channel: string, payload: unknown) => { sent.push({ channel, payload }) }),
      executeJavaScript: vi.fn(() => Promise.resolve(undefined)),
      openDevTools: vi.fn(),
      sentMessages: sent,
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

  /** Windows created by createServiceHostWindow, in spawn order. */
  const createdWindows: Array<ReturnType<typeof makeBrowserWindow>> = []
  /** Opts passed to each createServiceHostWindow call. */
  const createWindowCallOpts: Array<Record<string, unknown>> = []

  function createWindowForSpawn(opts?: Record<string, unknown>) {
    const win = makeBrowserWindow()
    createdWindows.push(win)
    if (opts !== undefined) createWindowCallOpts.push(opts)
    return win
  }

  function reset() {
    onListeners.clear()
    invokeHandlers.clear()
    wcById.clear()
    createdWindows.length = 0
    createWindowCallOpts.length = 0
    nextWcId = 4000
  }

  return {
    onListeners, invokeHandlers, wcById,
    makeEmitter, makeWebContents, makeBrowserWindow, createWindowForSpawn,
    createdWindows, createWindowCallOpts,
    reset,
  }
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

// Pooling is OFF in this suite (fresh-window path), so every spawn goes through
// createServiceHostWindow. Opts are recorded for BUG-1 assertions.
vi.mock('../windows/service-host-window/create.js', () => ({
  serviceHostSpec: () => ({}),
  serviceHostPreloadPath: '/tmp/preload.cjs',
  SERVICE_HOST_PARTITION: 'persist:simulator',
  buildServiceHostSpawnUrl: () => 'file:///service.html',
  navigateServiceHost: vi.fn(() => Promise.resolve()),
  createServiceHostWindow: vi.fn((opts: Record<string, unknown>) => stubs.createWindowForSpawn(opts)),
  constructServiceHostWindow: vi.fn(() => stubs.createWindowForSpawn()),
}))

import { BRIDGE_CHANNELS as C } from '../../shared/bridge-channels.js'
import type { SpawnRequest, SpawnResult } from '../../shared/bridge-channels.js'
import type { WorkbenchContext } from '../services/workbench-context.js'

type AnyFn = (...args: unknown[]) => unknown
type MockWc = ReturnType<typeof stubs.makeWebContents>
type MockWin = ReturnType<typeof stubs.makeBrowserWindow>

const APP_ID = 'test-app'

let installBridgeRouter: typeof import('./bridge-router.js').installBridgeRouter

const PRIOR_POOL_ENV = process.env.DIMINA_PREWARM_POOL_SIZE
const PRIOR_DISABLE_ENV = process.env.DIMINA_PREWARM_DISABLE

beforeEach(async () => {
  // Pooling OFF: spawn takes the fresh-window path (createServiceHostWindow).
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

/** Build the minimal WorkbenchContext the bridge-router reads. */
function makeCtx(opts?: { getProjectPath?: () => string }): {
  ctx: WorkbenchContext
  simulatorWc: MockWc
} {
  const simulatorWc = stubs.makeWebContents()
  const workspace: Record<string, unknown> = { getSession: () => undefined }
  if (opts?.getProjectPath) workspace.getProjectPath = opts.getProjectPath
  const ctx = {
    registry: { add: (_fn: AnyFn) => {} },
    simulatorApis: { has: (_name: string) => false, invoke: async () => ({}) },
    windows: { mainWindow: { webContents: simulatorWc } },
    workspace,
    connections: createConnectionRegistry(),
  } as unknown as WorkbenchContext
  return { ctx, simulatorWc }
}

/** Invoke the SPAWN ipcMain.handle handler and return the result + service window. */
async function spawnSession(simulatorWc: MockWc): Promise<{
  result: SpawnResult
  serviceWc: MockWc
  serviceWindow: MockWin
}> {
  const handle = stubs.invokeHandlers.get(C.SPAWN)
  if (!handle) throw new Error('SPAWN handler not registered')
  const req: SpawnRequest = {
    appId: APP_ID,
    pagePath: 'pages/index/index',
    // Supply resourceBaseUrl so handleSpawn skips startDiminaResourceServer.
    resourceBaseUrl: 'http://127.0.0.1:1/',
  }
  const result = (await (handle as AnyFn)({ sender: simulatorWc }, req)) as SpawnResult
  const serviceWc = stubs.wcById.get(result.serviceWcId) as MockWc | undefined
  if (!serviceWc) throw new Error(`no mock webContents with id ${result.serviceWcId}`)
  const serviceWindow = stubs.createdWindows.find(w => w.webContents.id === result.serviceWcId)
  if (!serviceWindow) throw new Error('spawned service window not found among created windows')
  return { result, serviceWc, serviceWindow }
}

/** Flush the microtask queue so fire-and-forget async calls (disposeAppSession) complete. */
async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

// ── BUG-2: SPAWN vs teardown race ───────────────────────────────────────────

describe('bridge-router — spawn vs simulatorWc teardown race', () => {
  it('normal spawn (simulatorWc alive): session is registered and NOT prematurely disposed', async () => {
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)

    // simulatorWc.isDestroyed() returns false throughout — normal case.
    const { serviceWindow } = await spawnSession(simulatorWc)
    await flush()

    // The session must survive: getServiceWc resolves it and close is not called.
    expect(
      ctx.bridge!.getServiceWc(APP_ID),
      'a live simulator must not cause premature session disposal',
    ).not.toBeNull()
    expect(
      serviceWindow.close,
      'service window must not be closed for a live simulator',
    ).not.toHaveBeenCalled()
  })

  it('simulatorWc destroyed during spawn awaits: session and service window are disposed, not left as zombies', async () => {
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)

    // Mark the simulatorWc as destroyed BEFORE calling SPAWN.
    // This models the race: the WCV was torn down during handleSpawn's awaits
    // (loadAppConfig / createServiceHostWindow). Its 'destroyed' event already
    // fired before simulatorWc.once('destroyed', …) is registered, so the once
    // callback will never run — without the post-once isDestroyed() guard the
    // session persists as a zombie.
    simulatorWc.destroyed = true
    // Do NOT emit 'destroyed' — the event already happened in real life, and the
    // mock emitter won't fire listeners that weren't registered yet.

    const { serviceWindow } = await spawnSession(simulatorWc)
    await flush()

    // With the guard in place, disposeAppSession must have run: the session is
    // gone and the service-host window is closed.
    expect(
      ctx.bridge!.getServiceWc(APP_ID),
      'a simulatorWc destroyed before once registration must not leave a zombie session',
    ).toBeNull()
    expect(
      serviceWindow.close,
      'disposeAppSession must close the service-host window for a pre-destroyed simulatorWc',
    ).toHaveBeenCalledTimes(1)
  })
})

// ── BUG-1: partition uses entry-captured projectPath ────────────────────────

describe('bridge-router — createServiceHostWindow receives entry-captured projectPath', () => {
  it('projectPath passed to createServiceHostWindow matches the value at spawn ENTRY, not any later re-read', async () => {
    let callCount = 0
    const PROJECT_A = '/workspace/project-alpha'
    const PROJECT_B = '/workspace/project-beta'

    // getProjectPath: first call (entry capture) → PROJECT_A; any subsequent
    // call (simulating a project switch during awaits) → PROJECT_B.
    const getProjectPath = vi.fn(() => {
      callCount++
      return callCount === 1 ? PROJECT_A : PROJECT_B
    })

    const { ctx, simulatorWc } = makeCtx({ getProjectPath })
    installBridgeRouter(ctx)

    await spawnSession(simulatorWc)

    // createServiceHostWindow must have been called with the captured entry value.
    // Failure predicate: if handleSpawn re-read getProjectPath() inside the
    // createServiceHostWindow call, it would receive PROJECT_B (the second-call
    // value returned after the project switch), and this assertion would fail.
    expect(stubs.createWindowCallOpts).toHaveLength(1)
    expect(
      stubs.createWindowCallOpts[0]?.projectPath,
      'createServiceHostWindow must receive the projectPath captured at spawn ENTRY, not re-read',
    ).toBe(PROJECT_A)
  })

  it('when no projectPath is configured, createServiceHostWindow receives undefined projectPath', async () => {
    // Baseline: no workspace.getProjectPath → workspaceProjectPath = '' → opts.projectPath = undefined.
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)

    await spawnSession(simulatorWc)

    expect(stubs.createWindowCallOpts).toHaveLength(1)
    expect(
      stubs.createWindowCallOpts[0]?.projectPath,
      'no projectPath configured → createServiceHostWindow opts.projectPath is undefined',
    ).toBeUndefined()
  })
})
