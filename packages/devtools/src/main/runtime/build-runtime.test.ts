/**
 * TDD failing tests for `buildRuntime` (UNIMPLEMENTED).
 *
 * `buildRuntime` constructs the spec `Runtime` facade (workbench-model.md §3.2)
 * that a host receives in `config.setup(runtime)`. It is a thin PROJECTION of
 * the devtools-real `WorkbenchContext` (services/workbench-context.ts) plus the
 * injected Electron handles — NOT a clone/wrapper. These tests pin the
 * projection with fake deps so each contract clause can fail independently.
 *
 * Spec types referenced (packages/workbench/src/types.ts):
 *  - WorkspaceState  = { activeProjectPath: string | null; session: WorkbenchSession | null }
 *  - WorkbenchSession = { projectPath: string; port: number; startedAt: number }
 *  - WorkbenchContext (spec) exposes _registry / _senderPolicy as @internal.
 *
 * Projection sources on the devtools-real ctx:
 *  - workspace.getProjectPath() / getSession() drive WorkspaceState
 *  - ctx.registry (DisposableRegistry) backs context._registry + runtime.add
 *  - ctx.senderPolicy backs context._senderPolicy
 *  - ctx.simulatorApis.invoke(name, params) is the internal entry for call.simulator
 *  - there is NO devtools-ctx internal entry for host-service RPC, so
 *    call.host is marked it.todo below.
 */
import { describe, it, expect, vi } from 'vitest'

// build-runtime.ts transitively imports devtools main modules that touch
// 'electron' at module load; stub it so the test module resolves under vitest.
vi.mock('electron', () => ({
  ipcMain: {},
  BrowserWindow: class {},
  WebContentsView: class {},
}))

import type { WorkbenchContext } from '../services/workbench-context.js'
import { buildRuntime } from './build-runtime.js'
import type { BuildRuntimeDeps } from './build-runtime.js'

// ── fake deps ──────────────────────────────────────────────────────────────

/** Sentinel objects compared by reference (`toBe`) to catch clone/wrap bugs. */
const electron = { app: {}, dialog: {} } as unknown as typeof import('electron')
const mainWindow = {} as unknown
const toolbarView = {} as unknown
const ipc = {} as unknown
const rawIpcMain = {} as unknown
const windowsCtl = {} as unknown

/**
 * Minimal devtools-real WorkbenchContext fake — only fields buildRuntime is
 * expected to read for the projection. `registry`/`senderPolicy` are sentinels
 * for the @internal escape hatches; `workspace`/`simulatorApis` are the live
 * projection sources.
 */
function makeCtx(overrides: Partial<{
  projectPath: string
  session: { close: () => Promise<void>; port: number; appInfo: unknown } | null
  startedAt: number
}> = {}): WorkbenchContext {
  const projectPath = overrides.projectPath ?? ''
  const session = overrides.session ?? null
  const registry = { add: vi.fn(() => ({ dispose() {} })), disposeAll: vi.fn() }
  const senderPolicy = vi.fn(() => true)
  const simulatorApis = {
    has: (name: string) => name === 'login',
    invoke: vi.fn(async (_name: string, _params: unknown) => ({ ok: true })),
    register: () => () => {},
    list: () => ['login'],
    clear: () => {},
  }
  return {
    workspace: {
      getProjectPath: () => projectPath,
      getSession: () => session,
      hasActiveSession: () => session !== null,
    },
    registry,
    senderPolicy,
    simulatorApis,
  } as unknown as WorkbenchContext
}

function makeDeps(ctx: WorkbenchContext, busOn = makeBusOn()): BuildRuntimeDeps {
  return {
    electron,
    ctx,
    mainWindow,
    toolbarView,
    ipc,
    rawIpcMain,
    windowsCtl,
    busOn,
  } as unknown as BuildRuntimeDeps
}

/** Fake framework bus: records every (event, listener) and hands back a spy disposable. */
function makeBusOn() {
  const calls: Array<{ event: unknown; listener: (p: unknown) => void; disposed: boolean }> = []
  const fn = <E>(event: E, listener: (p: unknown) => void) => {
    const entry = { event, listener, disposed: false }
    calls.push(entry)
    return { dispose() { entry.disposed = true } }
  }
  return Object.assign(fn, { calls })
}

// ── 直通注入值（toBe 同引用） ───────────────────────────────────────────────

describe('buildRuntime — injected handles pass through by reference', () => {
  it('runtime.electron is the exact injected electron module (no clone/wrap)', () => {
    const rt = buildRuntime(makeDeps(makeCtx()))
    expect(rt.electron).toBe(electron)
  })

  it('runtime.mainWindow is the exact injected BrowserWindow', () => {
    const rt = buildRuntime(makeDeps(makeCtx()))
    expect(rt.mainWindow).toBe(mainWindow)
  })

  it('runtime.toolbarView is the exact injected WebContentsView', () => {
    const rt = buildRuntime(makeDeps(makeCtx()))
    expect(rt.toolbarView).toBe(toolbarView)
  })

  it('runtime.toolbarView is null when toolbar is not configured', () => {
    const rt = buildRuntime({ ...makeDeps(makeCtx()), toolbarView: null })
    expect(rt.toolbarView).toBeNull()
  })

  it('runtime.rawIpcMain is the exact injected ipcMain', () => {
    const rt = buildRuntime(makeDeps(makeCtx()))
    expect(rt.rawIpcMain).toBe(rawIpcMain)
  })

  it('runtime.ipc is the exact injected TypedIpcRegistry', () => {
    const rt = buildRuntime(makeDeps(makeCtx()))
    expect(rt.ipc).toBe(ipc)
  })

  it('runtime.windows is the exact injected windows controller', () => {
    const rt = buildRuntime(makeDeps(makeCtx()))
    expect(rt.windows).toBe(windowsCtl)
  })
})

// ── runtime.context: devtools ctx → spec WorkbenchContext 投影 ───────────────

describe('buildRuntime — context.workspace projects devtools workspace state', () => {
  it('reflects the active project path and live session (WorkspaceState fields)', () => {
    const session = { close: async () => {}, port: 5173, appInfo: { appId: 'demo' } }
    const rt = buildRuntime(makeDeps(makeCtx({ projectPath: '/p/demo', session, startedAt: 111 })))
    // WorkspaceState.activeProjectPath
    expect(rt.context.workspace.activeProjectPath).toBe('/p/demo')
    // WorkspaceState.session is a WorkbenchSession projection {projectPath, port, startedAt}
    expect(rt.context.workspace.session).not.toBeNull()
    expect(rt.context.workspace.session!.projectPath).toBe('/p/demo')
    expect(rt.context.workspace.session!.port).toBe(5173)
    expect(typeof rt.context.workspace.session!.startedAt).toBe('number')
  })

  it('maps "no open project" to activeProjectPath:null + session:null', () => {
    const rt = buildRuntime(makeDeps(makeCtx({ projectPath: '', session: null })))
    expect(rt.context.workspace.activeProjectPath).toBeNull()
    expect(rt.context.workspace.session).toBeNull()
  })
})

describe('buildRuntime — context exposes @internal escape hatches', () => {
  it('context._registry is exposed and wired to the devtools registry', () => {
    const ctx = makeCtx()
    const rt = buildRuntime(makeDeps(ctx))
    expect(rt.context._registry).toBeDefined()
    // Wired through: adding via the spec _registry hits the devtools registry.add
    const internalRegistry = (ctx as unknown as { registry: { add: ReturnType<typeof vi.fn> } }).registry
    const d = { dispose() {} }
    rt.context._registry.add(d)
    expect(internalRegistry.add).toHaveBeenCalledWith(d)
  })

  it('context._senderPolicy is exposed (not hidden despite @internal)', () => {
    const rt = buildRuntime(makeDeps(makeCtx()))
    expect(rt.context._senderPolicy).toBeDefined()
  })
})

// ── runtime.on → busOn 透传 ─────────────────────────────────────────────────

describe('buildRuntime — on() delegates to the injected framework bus', () => {
  it('forwards (event, listener) to busOn and returns its Disposable', () => {
    const bus = makeBusOn()
    const rt = buildRuntime(makeDeps(makeCtx(), bus))
    const listener = (): void => {}
    const sub = rt.on('session-changed', listener)
    expect(bus.calls).toHaveLength(1)
    expect(bus.calls[0]!.event).toBe('session-changed')
    expect(bus.calls[0]!.listener).toBe(listener)
    // Returned Disposable maps to the bus subscription.
    expect(bus.calls[0]!.disposed).toBe(false)
    sub.dispose()
    expect(bus.calls[0]!.disposed).toBe(true)
  })
})

// ── runtime.add → registry 注册 ─────────────────────────────────────────────

describe('buildRuntime — add() registers a disposable on the runtime registry', () => {
  it('registers a Disposable object and returns a Disposable', () => {
    const ctx = makeCtx()
    const rt = buildRuntime(makeDeps(ctx))
    const registry = (ctx as unknown as { registry: { add: ReturnType<typeof vi.fn> } }).registry
    const d = { dispose() {} }
    const handle = rt.add(d)
    expect(registry.add).toHaveBeenCalledWith(d)
    expect(typeof handle.dispose).toBe('function')
  })

  it('also accepts a bare dispose function', () => {
    const ctx = makeCtx()
    const rt = buildRuntime(makeDeps(ctx))
    const registry = (ctx as unknown as { registry: { add: ReturnType<typeof vi.fn> } }).registry
    const fn = (): void => {}
    const handle = rt.add(fn)
    expect(registry.add).toHaveBeenCalledWith(fn)
    expect(typeof handle.dispose).toBe('function')
  })
})

// ── runtime.call.simulator → ctx.simulatorApis.invoke ───────────────────────

describe('buildRuntime — call.simulator delegates to the simulator API registry', () => {
  it('invokes the declared simulator API on ctx.simulatorApis and returns its result', async () => {
    const ctx = makeCtx()
    const rt = buildRuntime(makeDeps(ctx))
    const apis = (ctx as unknown as { simulatorApis: { invoke: ReturnType<typeof vi.fn> } }).simulatorApis
    const result = await rt.call.simulator('login', { code: 'abc' })
    expect(apis.invoke).toHaveBeenCalledTimes(1)
    expect(apis.invoke.mock.calls[0]![0]).toBe('login')
    expect(result).toEqual({ ok: true })
  })
})

// ── runtime.call.host — no devtools-ctx internal entry exists yet ────────────

describe('buildRuntime — call.host (host-service RPC)', () => {
  // The devtools-real WorkbenchContext has no host-service invocation entry
  // (hostServices is a workbench-package concept; ctx only carries a toolbar
  // action table, not a host-RPC registry). There is no internal dispatch
  // surface for buildRuntime to delegate call.host to. Marked todo until the
  // entry exists; see report.
  it.todo('call.host delegates to a devtools-ctx host-service registry')
})
