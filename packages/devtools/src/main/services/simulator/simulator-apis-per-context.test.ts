/**
 * Workbench model refactor — "simulator-api per-context".
 *
 * `docs/workbench-model.md`: the simulator custom-API registry
 * must move OFF the process-global singleton and onto a per-`WorkbenchContext`
 * registry. This suite pins down three of the four contract clauses:
 *
 *  Requirement A — per-context registry:
 *    `createWorkbenchContext()` produces a `ctx.simulatorApis` of type
 *    `SimulatorApiRegistry`, and two distinct contexts get two distinct,
 *    fully-isolated registries (the bug the old global caused: API registered
 *    in context A leaking into context B).
 *
 *  Requirement C — simulator IPC reads per-context:
 *    `registerSimulatorIpc(ctx)` wires the `SimulatorCustomApiChannel.Invoke`
 *    handler to *that ctx's* `simulatorApis` — not to a global. (The `.List`
 *    channel was decommissioned — the simulator guest reaches the registry via
 *    the bridge channels, never a main-window handle — so the registry's own
 *    `list()` is asserted directly where the old tests drove the List IPC.)
 *    Two registrars over two contexts must surface two different API sets.
 *
 * (Requirement B — `instance.registerSimulatorApi` — and Requirement D —
 *  global deletion — live in the sibling files
 *  `src/main/app/instance-simulator-api.test.ts` and
 *  `src/main/simulator-apis-global-removed.test.ts`.)
 *
 * `ctx.simulatorApis` is a per-context field, and `registerSimulatorIpc`
 * reads it rather than the process-global `simulatorApiRegistry`. A failure
 * here points at a missing per-context field / wiring, not at a broken
 * harness.
 *
 * No Electron app is driven here — `createWorkbenchContext` is exercised
 * directly with a minimal electron mock, and `registerSimulatorIpc` is fed a
 * hand-built ctx so the List/Invoke handlers can be invoked in isolation.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// ── electron stub: capture ipcMain.handle registrations by channel ──────────
const stub = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => unknown
  const handlers = new Map<string, Handler>()

  function makeWebContents(id: number) {
    return {
      id,
      isDestroyed: () => false,
      getURL: () => '',
      send: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      removeListener: vi.fn(),
    }
  }

  function makeBrowserWindow(id: number) {
    const listeners: Record<string, Set<Handler>> = {}
    return {
      webContents: makeWebContents(id),
      isDestroyed: () => false,
      on(e: string, fn: Handler) { (listeners[e] ??= new Set()).add(fn); return this },
      once(e: string, fn: Handler) { (listeners[e] ??= new Set()).add(fn); return this },
      off(e: string, fn: Handler) { listeners[e]?.delete(fn); return this },
      removeListener(e: string, fn: Handler) { listeners[e]?.delete(fn); return this },
      emit(e: string, ...a: unknown[]) { for (const fn of [...(listeners[e] ?? [])]) fn(...a) },
      getContentSize: () => [1280, 980],
      setTitle: vi.fn(),
      setIcon: vi.fn(),
    }
  }

  return { handlers, makeBrowserWindow }
})

vi.mock('electron', () => {
  type Handler = (...args: unknown[]) => unknown
  const ipcMain = {
    handle: vi.fn((channel: string, fn: Handler) => { stub.handlers.set(channel, fn) }),
    removeHandler: vi.fn((channel: string) => { stub.handlers.delete(channel) }),
    on: vi.fn(),
    removeListener: vi.fn(),
  }
  const session = {
    fromPartition: vi.fn(() => ({
      webRequest: { onBeforeSendHeaders: vi.fn(), onHeadersReceived: vi.fn() },
      registerPreloadScript: vi.fn(),
    })),
  }
  return {
    ipcMain,
    session,
    BrowserWindow: class {},
    WebContentsView: class { webContents = {}; setBounds = vi.fn(); setBackgroundColor = vi.fn() },
    app: { getPath: vi.fn(() => '/tmp/dimina-test-userdata') },
    nativeTheme: { themeSource: 'system', on: vi.fn() },
    default: { ipcMain, session },
  }
})

// `createWorkbenchContext` transitively pulls in the local-projects provider,
// which writes to `<userData>`. Keep it off the real filesystem.
vi.mock('fs', async () => {
  const real = await vi.importActual<typeof import('fs')>('fs')
  return { ...real, default: { ...real }, realpathSync: vi.fn((p: string) => p) }
})

type SimulatorApiRegistry = import('./custom-apis.js').SimulatorApiRegistry
type WorkbenchContext = import('../workbench-context.js').WorkbenchContext

let createWorkbenchContext: typeof import('../workbench-context.js').createWorkbenchContext
let registerSimulatorIpc: typeof import('../../ipc/simulator.js').registerSimulatorIpc
let SimulatorCustomApiChannel: typeof import('../../../shared/ipc-channels.js').SimulatorCustomApiChannel

beforeEach(async () => {
  vi.resetModules()
  stub.handlers.clear()
  ;({ createWorkbenchContext } = await import('../workbench-context.js'))
  ;({ registerSimulatorIpc } = await import('../../ipc/simulator.js'))
  ;({ SimulatorCustomApiChannel } = await import('../../../shared/ipc-channels.js'))
})

let nextWcId = 100
/** Build a WorkbenchContext via the real factory with a fresh mock main window. */
function makeContext(): WorkbenchContext {
  const mainWindow = stub.makeBrowserWindow(nextWcId++) as unknown as import('electron').BrowserWindow
  return createWorkbenchContext({
    mainWindow,
    preloadPath: '/tmp/preload.js',
    rendererDir: '/tmp/renderer',
  })
}

// ── Requirement A — per-context registry on WorkbenchContext ─────────────────

describe('Requirement A: ctx.simulatorApis is a per-context SimulatorApiRegistry', () => {
  it('createWorkbenchContext() produces a `simulatorApis` with the full registry surface', () => {
    const ctx = makeContext()
    const reg = (ctx as unknown as { simulatorApis?: SimulatorApiRegistry }).simulatorApis

    // Catches "createWorkbenchContext never assigned ctx.simulatorApis".
    expect(reg, 'expected createWorkbenchContext to set ctx.simulatorApis').toBeDefined()
    // Catches "simulatorApis is some ad-hoc object missing registry methods".
    expect(typeof reg!.register).toBe('function')
    expect(typeof reg!.list).toBe('function')
    expect(typeof reg!.invoke).toBe('function')
    expect(typeof reg!.clear).toBe('function')
  })

  it('a fresh context starts with an empty registry', () => {
    const ctx = makeContext()
    const reg = (ctx as unknown as { simulatorApis: SimulatorApiRegistry }).simulatorApis
    // Catches a context that was seeded from leftover global state.
    expect(reg.list()).toEqual([])
  })

  it('two contexts get two DISTINCT registry objects', () => {
    const a = makeContext()
    const b = makeContext()
    const regA = (a as unknown as { simulatorApis: SimulatorApiRegistry }).simulatorApis
    const regB = (b as unknown as { simulatorApis: SimulatorApiRegistry }).simulatorApis

    // Catches "createWorkbenchContext returns the process-global singleton".
    expect(regA).not.toBe(regB)
  })

  it('registering an API in context A does NOT make it visible in context B (isolation)', async () => {
    const a = makeContext()
    const b = makeContext()
    const regA = (a as unknown as { simulatorApis: SimulatorApiRegistry }).simulatorApis
    const regB = (b as unknown as { simulatorApis: SimulatorApiRegistry }).simulatorApis

    regA.register('a-only', () => 'from-A')

    // The whole point of per-context: B must not see A's registration.
    expect(regA.list()).toContain('a-only')
    expect(regB.list()).not.toContain('a-only')
    await expect(regB.invoke('a-only', null)).rejects.toThrowError(/a-only/)
  })
})

// ── Requirement C — registerSimulatorIpc reads ctx.simulatorApis ─────────────

/** Minimal ctx shape `registerSimulatorIpc` consumes, plus `simulatorApis`. */
function makeIpcCtx(simulatorApis: SimulatorApiRegistry): Record<string, unknown> {
  return {
    views: {
      attachNativeSimulator: vi.fn(),
      detachSimulator: vi.fn(),
      setNativeSimulatorViewBounds: vi.fn(),
      reapplySafeArea: vi.fn(),
    },
    notify: {},
    // No policy → IpcRegistry wraps handlers ungated, so we can invoke them
    // directly without a trusted sender. The gate itself is covered elsewhere.
    senderPolicy: undefined,
    simulatorApis,
  }
}

const fakeEvent = { sender: { id: 1, isDestroyed: () => false, getURL: () => '' } }

describe('Requirement C: registerSimulatorIpc Invoke reads the passed ctx.simulatorApis', () => {
  it('the registry handed to the ctx lists its registered names (List IPC is decommissioned)', async () => {
    const reg = await import('./custom-apis.js').then((m) => m.createSimulatorApiRegistry())
    reg.register('ctx.alpha', () => 1)
    reg.register('ctx.beta', () => 2)

    const disposable = registerSimulatorIpc(makeIpcCtx(reg) as never)

    // The List channel must NOT come back (it has no consumer; the guest
    // reaches the registry via the bridge channels) — the registry surface
    // itself is the only name-enumeration path.
    expect(stub.handlers.has('simulator:custom-apis:list')).toBe(false)
    expect(reg.list()).toEqual(['ctx.alpha', 'ctx.beta'])

    await (disposable as { dispose: () => Promise<void> }).dispose()
  })

  it('Invoke calls the handler on the ctx handed to registerSimulatorIpc', async () => {
    const reg = await import('./custom-apis.js').then((m) => m.createSimulatorApiRegistry())
    const handler = vi.fn((p: unknown) => ({ echoed: p }))
    reg.register('ctx.echo', handler)

    const disposable = registerSimulatorIpc(makeIpcCtx(reg) as never)

    const invokeHandler = stub.handlers.get(SimulatorCustomApiChannel.Invoke)
    expect(invokeHandler, 'registerSimulatorIpc must register the Invoke handler').toBeDefined()

    const result = await invokeHandler!(fakeEvent, 'ctx.echo', { n: 7 })
    expect(handler).toHaveBeenCalledWith({ n: 7 })
    // Catches: Invoke routed through the global registry, where 'ctx.echo'
    // was never registered, so it would reject instead.
    expect(result).toEqual({ echoed: { n: 7 } })

    await (disposable as { dispose: () => Promise<void> }).dispose()
  })

  it('two registrars over two ctxs surface two DIFFERENT API sets (no global crosstalk)', async () => {
    const { createSimulatorApiRegistry } = await import('./custom-apis.js')
    const regA = createSimulatorApiRegistry()
    const regB = createSimulatorApiRegistry()
    regA.register('only.in.A', () => 'A')
    regB.register('only.in.B', () => 'B')

    // First registrar (ctx A) — capture its Invoke handler before the second
    // registrar overwrites the channel.
    const dispA = registerSimulatorIpc(makeIpcCtx(regA) as never)
    const invokeA = stub.handlers.get(SimulatorCustomApiChannel.Invoke)!
    expect(await invokeA(fakeEvent, 'only.in.A', null)).toBe('A')
    // ctx A must NOT see ctx B's API — a process-global registry would.
    await expect(Promise.resolve(invokeA(fakeEvent, 'only.in.B', null))).rejects.toThrowError(/only\.in\.B/)

    // Second registrar (ctx B) re-registers the channel against regB.
    const dispB = registerSimulatorIpc(makeIpcCtx(regB) as never)
    const invokeB = stub.handlers.get(SimulatorCustomApiChannel.Invoke)!

    // If the IPC handler still closed over a process-global registry, both
    // ctxs would dispatch the union. Per-context means strict isolation.
    expect(await invokeB(fakeEvent, 'only.in.B', null)).toBe('B')
    await expect(Promise.resolve(invokeB(fakeEvent, 'only.in.A', null))).rejects.toThrowError(/only\.in\.A/)

    await (dispA as { dispose: () => Promise<void> }).dispose()
    await (dispB as { dispose: () => Promise<void> }).dispose()
  })

  it('a name registered on ctx AFTER registerSimulatorIpc is still reachable via Invoke', async () => {
    const { createSimulatorApiRegistry } = await import('./custom-apis.js')
    const reg = createSimulatorApiRegistry()

    const disposable = registerSimulatorIpc(makeIpcCtx(reg) as never)
    const invokeHandler = stub.handlers.get(SimulatorCustomApiChannel.Invoke)!

    await expect(Promise.resolve(invokeHandler(fakeEvent, 'late.api', null))).rejects.toThrowError(/late\.api/)

    // Late registration — the IPC handler must read the live ctx registry,
    // not a snapshot taken at registerSimulatorIpc time.
    reg.register('late.api', () => 'late')
    expect(await invokeHandler(fakeEvent, 'late.api', null)).toBe('late')

    await (disposable as { dispose: () => Promise<void> }).dispose()
  })
})
