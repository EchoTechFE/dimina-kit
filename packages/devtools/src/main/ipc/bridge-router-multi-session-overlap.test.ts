/**
 * Simulator soft reload lets a recompile spawn a NEW app session (B) into the
 * SAME simulator webContents (sender) before the OLD session (A) is disposed,
 * so the two briefly overlap while the new one loads in the background. The
 * shared wc's sessions live in `state.simulatorWcIdToAppSessionIds` — one Set
 * per wc, in spawn order — and `senderBoundToSession` authorizes the wc for
 * ANY session it hosts.
 *
 * These tests pin the contract for that overlap window: the simulator wc may
 * act on behalf of whichever session a message explicitly names (DISPOSE /
 * ACTIVE_PAGE / PAGE_LIFECYCLE), not just the most-recently-spawned one, and
 * disposing an old session must never corrupt the surviving one's bookkeeping
 * (it sheds only its own Set membership) nor leave its own hooks behind on the
 * shared wc.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createConnectionRegistry } from '@dimina-kit/electron-deck/main'

const stubs = vi.hoisted(() => {
  type AnyFn = (...args: unknown[]) => unknown
  type EventBag = Record<string, Set<AnyFn>>

  const onListeners = new Map<string, Set<AnyFn>>()
  const invokeHandlers = new Map<string, AnyFn>()

  function makeEmitter() {
    const listeners: EventBag = {}
    // Node's removeListener(fn) also removes the internal once() wrapper for
    // fn (it keeps a `.listener` back-reference); mirror that so production
    // code detaching its own once() hooks behaves the same against this mock.
    const removeMatching = (event: string, fn: AnyFn): void => {
      const set = listeners[event]
      if (!set) return
      for (const l of [...set]) {
        if (l === fn || (l as AnyFn & { listener?: AnyFn }).listener === fn) set.delete(l)
      }
    }
    const api = {
      listeners,
      on(event: string, fn: AnyFn) { (listeners[event] ??= new Set()).add(fn); return api },
      once(event: string, fn: AnyFn) {
        const wrap: AnyFn & { listener?: AnyFn } = (...a: unknown[]) => { listeners[event]?.delete(wrap); return fn(...a) }
        wrap.listener = fn
        ;(listeners[event] ??= new Set()).add(wrap); return api
      },
      off(event: string, fn: AnyFn) { removeMatching(event, fn); return api },
      removeListener(event: string, fn: AnyFn) { removeMatching(event, fn); return api },
      emit(event: string, ...a: unknown[]) { for (const fn of [...(listeners[event] ?? [])]) fn(...a) },
    }
    return api
  }

  let nextWcId = 7000
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

  const createdWindows: Array<ReturnType<typeof makeBrowserWindow>> = []

  function createWindowForSpawn(opts?: Record<string, unknown>) {
    const win = makeBrowserWindow()
    createdWindows.push(win)
    void opts
    return win
  }

  function reset() {
    onListeners.clear()
    invokeHandlers.clear()
    wcById.clear()
    createdWindows.length = 0
    nextWcId = 7000
  }

  return {
    onListeners, invokeHandlers, wcById,
    makeEmitter, makeWebContents, makeBrowserWindow, createWindowForSpawn,
    createdWindows,
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

// Pooling is OFF in this suite — every spawn takes the fresh-window path, so
// the overlap between A and B is purely the shared-simulator-wc mapping, not
// a shared pooled service window.
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
import type { DisposePayload, ActivePagePayload, PageLifecyclePayload, SpawnRequest, SpawnResult } from '../../shared/bridge-channels.js'
import type { WorkbenchContext } from '../services/workbench-context.js'

type AnyFn = (...args: unknown[]) => unknown
type MockWc = ReturnType<typeof stubs.makeWebContents>
type MockWin = ReturnType<typeof stubs.makeBrowserWindow>

const APP_ID = 'overlap-app'
const ROOT_A = 'pages/root-a/root-a'
const ROOT_B = 'pages/root-b/root-b'
const SECOND_PAGE = 'pages/second/second'

let installBridgeRouter: typeof import('./bridge-router.js').installBridgeRouter

let originalFetch: typeof globalThis.fetch

beforeEach(async () => {
  vi.resetModules()
  stubs.reset()
  originalFetch = globalThis.fetch
  globalThis.fetch = vi.fn((input: string | URL | Request) => {
    const href = typeof input === 'string' ? input
      : input instanceof URL ? input.href
      : (input as Request).url
    if (href.includes('app-config.json')) {
      const body = { app: { entryPagePath: ROOT_A, pages: [ROOT_A, ROOT_B, SECOND_PAGE] } }
      return Promise.resolve({
        ok: true, status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as unknown as Response)
    }
    return Promise.resolve({ ok: true, status: 200, text: async () => '', json: async () => ({}) } as unknown as Response)
  }) as unknown as typeof fetch
  ;({ installBridgeRouter } = await import('./bridge-router.js'))
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

function makeCtx(): { ctx: WorkbenchContext; simulatorWc: MockWc } {
  const simulatorWc = stubs.makeWebContents()
  const ctx = {
    registry: { add: (_fn: AnyFn) => {} },
    simulatorApis: { has: (_name: string) => false, invoke: async () => ({}) },
    windows: { mainWindow: { webContents: simulatorWc } },
    workspace: { getSession: () => undefined },
    connections: createConnectionRegistry(),
  } as unknown as WorkbenchContext
  return { ctx, simulatorWc }
}

async function spawnSession(
  simulatorWc: MockWc,
  opts: { pagePath: string },
): Promise<{ result: SpawnResult; serviceWc: MockWc; serviceWindow: MockWin }> {
  const handle = stubs.invokeHandlers.get(C.SPAWN)
  if (!handle) throw new Error('SPAWN handler not registered')
  const req: SpawnRequest = {
    appId: APP_ID,
    pagePath: opts.pagePath,
    resourceBaseUrl: 'http://127.0.0.1:1/',
  }
  const result = (await (handle as AnyFn)({ sender: simulatorWc }, req)) as SpawnResult
  const serviceWc = stubs.wcById.get(result.serviceWcId) as MockWc | undefined
  if (!serviceWc) throw new Error(`no mock webContents with id ${result.serviceWcId}`)
  const serviceWindow = stubs.createdWindows.find(w => w.webContents.id === result.serviceWcId)
  if (!serviceWindow) throw new Error('spawned service window not found')
  return { result, serviceWc, serviceWindow }
}

/** Open a second (non-root) page under an already-spawned app session. */
async function openSecondPage(simulatorWc: MockWc, appSessionId: string, pagePath: string): Promise<string> {
  const handle = stubs.invokeHandlers.get(C.PAGE_OPEN)
  if (!handle) throw new Error('PAGE_OPEN handler not registered')
  const res = (await (handle as AnyFn)({ sender: simulatorWc }, { appSessionId, pagePath })) as { bridgeId: string }
  return res.bridgeId
}

function emitDispose(simulatorWc: MockWc, payload: DisposePayload): void {
  const listeners = stubs.onListeners.get(C.DISPOSE)
  if (!listeners) throw new Error('DISPOSE handler not registered')
  for (const fn of [...listeners]) (fn as AnyFn)({ sender: simulatorWc }, payload)
}

function emitActivePage(simulatorWc: MockWc, payload: ActivePagePayload): void {
  const listeners = stubs.onListeners.get(C.ACTIVE_PAGE)
  if (!listeners) throw new Error('ACTIVE_PAGE handler not registered')
  for (const fn of [...listeners]) (fn as AnyFn)({ sender: simulatorWc }, payload)
}

function emitPageLifecycle(simulatorWc: MockWc, payload: PageLifecyclePayload): void {
  const listeners = stubs.onListeners.get(C.PAGE_LIFECYCLE)
  if (!listeners) throw new Error('PAGE_LIFECYCLE handler not registered')
  for (const fn of [...listeners]) (fn as AnyFn)({ sender: simulatorWc }, payload)
}

/** Flush the microtask queue so any fire-and-forget dispose tail settles. */
async function flush(n = 10): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

describe('bridge-router — overlapping app sessions on one simulator webContents (soft reload)', () => {
  it('disposes the OLDER session (A) via DISPOSE even after a NEWER session (B) spawned on the same wc', async () => {
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)

    const A = await spawnSession(simulatorWc, { pagePath: ROOT_A })
    // B spawns from the SAME simulator wc — sender-resolution now favors B
    // (latest spawn), but a message explicitly naming A must still act on A.
    const B = await spawnSession(simulatorWc, { pagePath: ROOT_B })

    emitDispose(simulatorWc, { bridgeId: A.result.appSessionId })
    await flush()

    expect(
      A.serviceWindow.close,
      'DISPOSE naming A\'s appSessionId must tear A down (close A\'s service window), even though the simulator wc\'s sender-resolved session is now B',
    ).toHaveBeenCalled()
    expect(
      B.serviceWindow.close,
      'disposing A must not touch B\'s service window',
    ).not.toHaveBeenCalled()
  })

  it('keeps B\'s wc→session binding intact after A is disposed, so a later ACTIVE_PAGE for B is still honored', async () => {
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)

    const A = await spawnSession(simulatorWc, { pagePath: ROOT_A })
    const B = await spawnSession(simulatorWc, { pagePath: ROOT_B })
    // A distinct, non-root bridgeId for B so a no-op (root bridgeId already
    // being the activeBridgeId fallback) can't hide the bug.
    const bSecondBridgeId = await openSecondPage(simulatorWc, B.result.appSessionId, SECOND_PAGE)

    // Dispose A from A's OWN service-host wc — this sender unambiguously maps
    // to A, so disposeAppSession(A) definitely runs. What THIS test pins is
    // what happens to B's bookkeeping once it does: A's dispose must shed only
    // A's own membership in the shared wc's session Set, leaving B's intact.
    emitDispose(A.serviceWc, { bridgeId: A.result.appSessionId })
    await flush()

    emitActivePage(simulatorWc, { appSessionId: B.result.appSessionId, bridgeId: bSecondBridgeId })

    expect(
      ctx.bridge?.getActiveBridgeId?.(APP_ID),
      'ACTIVE_PAGE for B, sent from the shared simulator wc AFTER A was disposed, must still update B\'s active page — disposeAppSession must not blow away a wc→session binding it no longer owns',
    ).toBe(bSecondBridgeId)
  })

  it('forwards PAGE_LIFECYCLE for the OLDER session (A) to A\'s service host while B is the wc\'s most-recently-spawned session', async () => {
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)
    void ctx

    const A = await spawnSession(simulatorWc, { pagePath: ROOT_A })
    // B overwrites the wc→session binding; A must still be reachable by name.
    await spawnSession(simulatorWc, { pagePath: ROOT_B })

    emitPageLifecycle(simulatorWc, {
      appSessionId: A.result.appSessionId,
      bridgeId: A.result.bridgeId,
      event: 'pageHide',
    })

    const forwarded = A.serviceWc.sentMessages.filter(m =>
      m.channel === C.TO_SERVICE
      && (m.payload as { msg: { type: string; body: { bridgeId: string } } }).msg?.type === 'pageHide'
      && (m.payload as { msg: { body: { bridgeId: string } } }).msg.body.bridgeId === A.result.bridgeId)
    expect(
      forwarded.length,
      `PAGE_LIFECYCLE naming A's appSessionId must reach A's service host even though the simulator wc's sender-resolved session is now B; A received: ${JSON.stringify(A.serviceWc.sentMessages.map(m => m.channel))}`,
    ).toBe(1)
  })

  it('removes a disposed session\'s \'destroyed\' hook from the shared simulator wc (no per-soft-reload listener growth)', async () => {
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)
    void ctx

    // Each spawn hangs one 'destroyed' teardown hook on the SAME wc. The wc
    // survives every soft reload, so a gracefully-disposed session that left
    // its hook behind would grow the listener set by one per recompile until
    // Node's MaxListeners warning fires (~11 saves into a session).
    const A = await spawnSession(simulatorWc, { pagePath: ROOT_A })
    await spawnSession(simulatorWc, { pagePath: ROOT_B })
    expect(simulatorWc.listeners['destroyed']?.size ?? 0).toBe(2)

    emitDispose(simulatorWc, { bridgeId: A.result.appSessionId })
    await flush()

    expect(
      simulatorWc.listeners['destroyed']?.size ?? 0,
      'disposing A must detach A\'s own once(\'destroyed\') from the shared simulator wc, leaving only B\'s',
    ).toBe(1)
  })

  it('keeps the shared simulator wc\'s \'destroyed\' hook count flat across repeated spawn→dispose (soft reload) cycles', async () => {
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)
    void ctx

    for (let cycle = 1; cycle <= 5; cycle++) {
      const session = await spawnSession(simulatorWc, { pagePath: cycle % 2 === 0 ? ROOT_B : ROOT_A })
      emitDispose(simulatorWc, { bridgeId: session.result.appSessionId })
      await flush()

      expect(
        simulatorWc.listeners['destroyed']?.size ?? 0,
        `cycle ${cycle}: a session that disposes itself must leave no 'destroyed' hooks on the surviving simulator wc`,
      ).toBe(0)
    }

    // One more spawn with no matching dispose confirms the flat count above
    // isn't an artifact of nothing ever being attached — a live session's
    // hook is present and exactly one.
    await spawnSession(simulatorWc, { pagePath: ROOT_A })
    expect(
      simulatorWc.listeners['destroyed']?.size ?? 0,
      'an undisposed session leaves exactly its own \'destroyed\' hook on the simulator wc',
    ).toBe(1)
  })
})
