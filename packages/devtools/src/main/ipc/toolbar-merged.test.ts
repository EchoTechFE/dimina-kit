/**
 * Workbench model refactor — "toolbar 合一".
 *
 * `docs/workbench-model.md`. This suite pins down
 * Requirements B, C and D of the toolbar merge:
 *
 *  Requirement B — per-context toolbar state:
 *    Each `WorkbenchContext` holds its OWN current toolbar actions (handlers
 *    included). Two contexts are fully isolated — a `set()` on one is
 *    invisible to the other.
 *
 *  Requirement C — `registerToolbarIpc` reads per-context + new Invoke channel:
 *    - `registerToolbarIpc(ctx)` wires `ToolbarChannel.GetActions` to read
 *      THIS ctx's current toolbar actions, projected to `{id,label}[]` — the
 *      non-serializable `handler` must NEVER cross the IPC boundary.
 *    - A new `ToolbarChannel.Invoke` handler takes an action id, looks up the
 *      handler stored on THIS ctx and calls it. An unknown id rejects.
 *
 *  Requirement D — old paths deleted:
 *    - `ToolbarChannel.ActionPrefix` is gone; `ToolbarChannel.Invoke` exists
 *      and equals `'toolbar:invoke'`.
 *    - `WorkbenchConfig` / `CreateContextOptions` no longer carry a
 *      `toolbarActions` field; a created `WorkbenchContext` has no
 *      `toolbarActions`.
 *    - `view-api.ts`'s `invokeToolbarAction` no longer references
 *      `ActionPrefix` (source scan).
 *
 * Together these pin the per-context toolbar store, the `Invoke` channel, and
 * the removal of the legacy `ctx.toolbarActions` path. Failures must point at
 * the missing feature, not at a broken harness.
 *
 * Seam: `registerToolbarIpc` is fed a real `WorkbenchContext` built by
 * `createWorkbenchContext` (so the test never names the internal toolbar
 * field) and the host-facing `instance.toolbar.set` is reached through the
 * full app driven under an exhaustive electron mock — same seam as
 * `instance-toolbar-api.test.ts`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ── electron stub: capture ipcMain.handle + main-window webContents.send ─────
const stubs = vi.hoisted(() => {
  type AnyFn = (...args: unknown[]) => unknown
  type EventBag = Record<string, Set<AnyFn>>

  const ipcHandlers = new Map<string, AnyFn>()
  const sendCalls: Array<{ channel: string; args: unknown[] }> = []

  function makeEmitter() {
    const listeners: EventBag = {}
    return {
      listeners,
      on(event: string, fn: AnyFn) { (listeners[event] ??= new Set()).add(fn); return this },
      once(event: string, fn: AnyFn) {
        const wrap: AnyFn = (...a: unknown[]) => { listeners[event]?.delete(wrap); return fn(...a) }
        ;(listeners[event] ??= new Set()).add(wrap); return this
      },
      off(event: string, fn: AnyFn) { listeners[event]?.delete(fn); return this },
      removeListener(event: string, fn: AnyFn) { listeners[event]?.delete(fn); return this },
      emit(event: string, ...a: unknown[]) { for (const fn of [...(listeners[event] ?? [])]) fn(...a) },
    }
  }

  function makeWebContents(id: number) {
    return {
      ...makeEmitter(),
      id,
      destroyed: false,
      isDestroyed() { return this.destroyed },
      getURL: () => '',
      send: vi.fn((channel: string, ...args: unknown[]) => {
        sendCalls.push({ channel, args })
      }),
    }
  }

  function makeBrowserWindow(id: number) {
    const em = makeEmitter()
    return {
      ...em,
      webContents: makeWebContents(id),
      destroyed: false,
      isDestroyed() { return this.destroyed },
      getContentSize: () => [1280, 980],
      setTitle: vi.fn(),
      setIcon: vi.fn(),
    }
  }

  function reset() {
    ipcHandlers.clear()
    sendCalls.length = 0
  }

  return { ipcHandlers, sendCalls, makeEmitter, makeWebContents, makeBrowserWindow, reset }
})

vi.mock('electron', () => {
  type AnyFn = (...args: unknown[]) => unknown
  const ipcMain = {
    handle: vi.fn((channel: string, fn: AnyFn) => { stubs.ipcHandlers.set(channel, fn) }),
    removeHandler: vi.fn((channel: string) => { stubs.ipcHandlers.delete(channel) }),
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

type WorkbenchContext = import('../services/workbench-context.js').WorkbenchContext
type ToolbarActionInput = {
  id: string
  label: string
  kind?: 'button' | 'avatar'
  placement?: 'leading' | 'primary' | 'trailing'
  icon?: string
  displayInitial?: string
  avatarUrl?: string
  handler: () => void | Promise<void>
}

let createWorkbenchContext: typeof import('../services/workbench-context.js').createWorkbenchContext
let registerToolbarIpc: typeof import('./toolbar.js').registerToolbarIpc
// Accessed as a string-keyed record so a test can assert on the presence of
// `Invoke` and the absence of `ActionPrefix` without TS errors against the
// enum's concrete shape.
let ToolbarChannel: Record<string, string>

beforeEach(async () => {
  vi.resetModules()
  stubs.reset()
  ;({ createWorkbenchContext } = await import('../services/workbench-context.js'))
  ;({ registerToolbarIpc } = await import('./toolbar.js'))
  ToolbarChannel = (await import('../../shared/ipc-channels.js'))
    .ToolbarChannel as unknown as Record<string, string>
})

let nextWcId = 200
/**
 * Build a WorkbenchContext via the real factory with a fresh mock main
 * window. The real `senderPolicy` is overridden to `undefined` so
 * `registerToolbarIpc` wraps its handlers UNGATED — the gate itself is
 * covered by the IpcRegistry / sender-policy suites; this suite invokes the
 * GetActions / Invoke handlers directly with a bare event.
 */
function makeContext(): WorkbenchContext {
  const mainWindow = stubs.makeBrowserWindow(nextWcId++) as unknown as import('electron').BrowserWindow
  const ctx = createWorkbenchContext({
    mainWindow,
    preloadPath: '/tmp/preload.js',
    rendererDir: '/tmp/renderer',
  })
  ;(ctx as { senderPolicy?: unknown }).senderPolicy = undefined
  return ctx
}

const fakeEvent = { sender: { id: 1, isDestroyed: () => false, getURL: () => '' } }

/**
 * Push a batch of host actions into a context's toolbar store. The only
 * supported way to populate per-context toolbar state is `instance.toolbar`;
 * since this suite drives `registerToolbarIpc` against a bare context, it
 * relies on the context exposing the SAME store the host surface writes to.
 *
 * The exact field name is an implementation detail; this helper reaches the
 * store via `ctx.toolbar.set(...)` and is the single place to adjust if that
 * shape changes.
 */
function setToolbar(ctx: WorkbenchContext, actions: ToolbarActionInput[]): void {
  const store = (ctx as unknown as { toolbar?: { set?: (a: ToolbarActionInput[]) => void } }).toolbar
  if (!store || typeof store.set !== 'function') {
    throw new Error(
      'expected WorkbenchContext to expose a per-context toolbar store with set() — Requirement B',
    )
  }
  store.set(actions)
}

// ── Requirement B — per-context toolbar state ───────────────────────────────

describe('Requirement B: per-context toolbar state', () => {
  it('a fresh context exposes a per-context toolbar store, starting empty', async () => {
    const ctx = makeContext()

    // Requirement B: the context itself carries the toolbar store. Catches an
    // `instance.toolbar` wired to some ad-hoc closure instead of a field on
    // WorkbenchContext (which registerToolbarIpc must read).
    const store = (ctx as unknown as { toolbar?: { set?: unknown } }).toolbar
    expect(store, 'createWorkbenchContext must set a per-context toolbar store').toBeDefined()
    expect(typeof store!.set).toBe('function')

    // A fresh store projects to an empty {id,label}[] through GetActions.
    const disposable = registerToolbarIpc(ctx as never)
    const getActions = stubs.ipcHandlers.get(ToolbarChannel.GetActions)!
    expect(await getActions(fakeEvent)).toEqual([])

    await (disposable as { dispose: () => Promise<void> }).dispose()
  })

  it('two contexts hold independent toolbar state (isolation)', async () => {
    const a = makeContext()
    const b = makeContext()

    setToolbar(a, [{ id: 'a-only', label: 'A', handler: vi.fn() }])

    // Register the IPC against ctx B and read it — B must NOT see A's action.
    const dispB = registerToolbarIpc(b as never)
    const getB = stubs.ipcHandlers.get(ToolbarChannel.GetActions)!
    expect(
      await getB(fakeEvent),
      'context B must not see toolbar actions set on context A',
    ).toEqual([])

    // And A still has its own.
    const dispA = registerToolbarIpc(a as never)
    const getA = stubs.ipcHandlers.get(ToolbarChannel.GetActions)!
    expect(await getA(fakeEvent)).toEqual([{ id: 'a-only', label: 'A' }])

    await (dispA as { dispose: () => Promise<void> }).dispose()
    await (dispB as { dispose: () => Promise<void> }).dispose()
  })
})

// ── Requirement C — registerToolbarIpc reads per-context + Invoke ────────────

describe('Requirement C: GetActions returns {id,label} (no handler leak)', () => {
  it('GetActions surfaces the per-context actions as {id,label}', async () => {
    const ctx = makeContext()
    setToolbar(ctx, [
      { id: 'login', label: '登录', handler: vi.fn() },
      { id: 'sync', label: '同步', handler: vi.fn() },
    ])

    const disposable = registerToolbarIpc(ctx as never)
    const getActions = stubs.ipcHandlers.get(ToolbarChannel.GetActions)!

    expect(await getActions(fakeEvent)).toEqual([
      { id: 'login', label: '登录' },
      { id: 'sync', label: '同步' },
    ])

    await (disposable as { dispose: () => Promise<void> }).dispose()
  })

  it('GetActions surfaces optional serializable display metadata', async () => {
    const ctx = makeContext()
    setToolbar(ctx, [
      {
        id: 'account',
        label: '当前用户：Ada',
        kind: 'avatar',
        placement: 'leading',
        icon: 'A',
        displayInitial: 'Ada',
        avatarUrl: 'https://example.com/avatar.png',
        handler: vi.fn(),
      },
    ])

    const disposable = registerToolbarIpc(ctx as never)
    const getActions = stubs.ipcHandlers.get(ToolbarChannel.GetActions)!

    expect(await getActions(fakeEvent)).toEqual([
      {
        id: 'account',
        label: '当前用户：Ada',
        kind: 'avatar',
        placement: 'leading',
        icon: 'A',
        displayInitial: 'Ada',
        avatarUrl: 'https://example.com/avatar.png',
      },
    ])

    await (disposable as { dispose: () => Promise<void> }).dispose()
  })

  it('GetActions NEVER leaks the non-serializable handler across IPC', async () => {
    const ctx = makeContext()
    const handler = vi.fn()
    setToolbar(ctx, [{ id: 'x', label: 'X', handler }])

    const disposable = registerToolbarIpc(ctx as never)
    const getActions = stubs.ipcHandlers.get(ToolbarChannel.GetActions)!

    const result = (await getActions(fakeEvent)) as Array<Record<string, unknown>>
    // A handler function cannot be structured-cloned across the IPC boundary;
    // GetActions must project to a plain {id,label}. Catches a handler that
    // is passed through verbatim.
    expect(result[0]).not.toHaveProperty('handler')
    expect(Object.keys(result[0]!).sort()).toEqual(['id', 'label'])

    await (disposable as { dispose: () => Promise<void> }).dispose()
  })
})

describe('Requirement C: ToolbarChannel.Invoke routes to the per-context handler', () => {
  it('Invoke calls the handler stored under the given id on THIS context', async () => {
    const ctx = makeContext()
    const handler = vi.fn()
    setToolbar(ctx, [
      { id: 'noop', label: 'Noop', handler: vi.fn() },
      { id: 'do-it', label: 'Do It', handler },
    ])

    const disposable = registerToolbarIpc(ctx as never)
    const invoke = stubs.ipcHandlers.get(ToolbarChannel.Invoke)
    expect(invoke, 'registerToolbarIpc must register a ToolbarChannel.Invoke handler').toBeDefined()

    await invoke!(fakeEvent, 'do-it')

    // Catches: Invoke not wired, or routed to the wrong handler.
    expect(handler).toHaveBeenCalledTimes(1)

    await (disposable as { dispose: () => Promise<void> }).dispose()
  })

  it('Invoke awaits an async handler before resolving', async () => {
    const ctx = makeContext()
    let ran = false
    setToolbar(ctx, [
      {
        id: 'async-action',
        label: 'Async',
        handler: async () => {
          await Promise.resolve()
          ran = true
        },
      },
    ])

    const disposable = registerToolbarIpc(ctx as never)
    const invoke = stubs.ipcHandlers.get(ToolbarChannel.Invoke)!

    await invoke(fakeEvent, 'async-action')
    // Catches: Invoke fires the handler but doesn't await it.
    expect(ran).toBe(true)

    await (disposable as { dispose: () => Promise<void> }).dispose()
  })

  it('Invoke rejects when the id is not registered on this context', async () => {
    const ctx = makeContext()
    setToolbar(ctx, [{ id: 'known', label: 'Known', handler: vi.fn() }])

    const disposable = registerToolbarIpc(ctx as never)
    const invoke = stubs.ipcHandlers.get(ToolbarChannel.Invoke)!

    // Unknown id must reject — silently swallowing it would hide host bugs.
    await expect(
      Promise.resolve(invoke(fakeEvent, 'no-such-action')),
    ).rejects.toThrow()

    await (disposable as { dispose: () => Promise<void> }).dispose()
  })

  it('a replaced action’s stale handler is no longer reachable via Invoke', async () => {
    const ctx = makeContext()
    const oldHandler = vi.fn()
    setToolbar(ctx, [{ id: 'old', label: 'Old', handler: oldHandler }])

    // Whole-table replace: 'old' is dropped, 'new' takes its place.
    setToolbar(ctx, [{ id: 'new', label: 'New', handler: vi.fn() }])

    const disposable = registerToolbarIpc(ctx as never)
    const invoke = stubs.ipcHandlers.get(ToolbarChannel.Invoke)!

    // Invoking the dropped id must reject — a stale handler kept in some
    // never-cleared map would silently fire instead.
    await expect(Promise.resolve(invoke(fakeEvent, 'old'))).rejects.toThrow()
    expect(
      oldHandler,
      'the handler of a replaced action must never be invoked again',
    ).not.toHaveBeenCalled()

    await (disposable as { dispose: () => Promise<void> }).dispose()
  })

  it('Invoke routes to the per-context handler, not a sibling context (isolation)', async () => {
    const a = makeContext()
    const b = makeContext()
    const handlerA = vi.fn()
    setToolbar(a, [{ id: 'shared-id', label: 'A', handler: handlerA }])
    // ctx B has NOTHING under 'shared-id'.

    const dispB = registerToolbarIpc(b as never)
    const invokeB = stubs.ipcHandlers.get(ToolbarChannel.Invoke)!

    // Invoking on B's IPC must NOT reach A's handler — it must reject.
    await expect(Promise.resolve(invokeB(fakeEvent, 'shared-id'))).rejects.toThrow()
    expect(handlerA).not.toHaveBeenCalled()

    await (dispB as { dispose: () => Promise<void> }).dispose()
  })
})

// ── Requirement D — old paths deleted ───────────────────────────────────────

describe('Requirement D: old toolbar paths are deleted', () => {
  it('ToolbarChannel.ActionPrefix no longer exists', async () => {
    const channels = (await import('../../shared/ipc-channels.js')).ToolbarChannel as Record<string, unknown>
    // The bare `toolbar:action:*` dynamic-channel scheme is replaced by Invoke.
    expect(
      channels.ActionPrefix,
      'ToolbarChannel.ActionPrefix must be removed',
    ).toBeUndefined()
  })

  it('ToolbarChannel.Invoke exists and equals "toolbar:invoke"', async () => {
    const channels = (await import('../../shared/ipc-channels.js')).ToolbarChannel as Record<string, unknown>
    expect(channels.Invoke, 'ToolbarChannel.Invoke must be added').toBeDefined()
    // Assert the value, not just presence, so a typo'd channel is also caught.
    expect(channels.Invoke).toBe('toolbar:invoke')
  })

  it('a created WorkbenchContext has no `toolbarActions` field', () => {
    const ctx = makeContext()
    // The provider-style config field is deleted; per-context state replaces it.
    expect(
      Object.prototype.hasOwnProperty.call(ctx, 'toolbarActions'),
      'WorkbenchContext.toolbarActions must be removed',
    ).toBe(false)
  })

  it('createWorkbenchContext ignores / no longer accepts a `toolbarActions` option', () => {
    // Passing the deleted option through must not resurrect a `toolbarActions`
    // field on the context. The option object is cast to the factory's param
    // type so the test compiles even though `CreateContextOptions` no longer
    // carries `toolbarActions`.
    const mainWindow = stubs.makeBrowserWindow(nextWcId++) as unknown as import('electron').BrowserWindow
    const opts = {
      mainWindow,
      preloadPath: '/tmp/preload.js',
      rendererDir: '/tmp/renderer',
      toolbarActions: () => [{ id: 'ghost', label: 'Ghost' }],
    } as unknown as Parameters<typeof createWorkbenchContext>[0]
    const ctx = createWorkbenchContext(opts)
    expect((ctx as unknown as Record<string, unknown>).toolbarActions).toBeUndefined()
  })

  it('view-api.ts no longer references ToolbarChannel.ActionPrefix (source scan)', () => {
    // invokeToolbarAction must invoke ToolbarChannel.Invoke, not splice
    // `${ActionPrefix}${id}`. A source scan catches the leftover string-build.
    const here = path.dirname(fileURLToPath(import.meta.url))
    const viewApiPath = path.resolve(here, '../../renderer/shared/api/view-api.ts')
    const src = fs.readFileSync(viewApiPath, 'utf8')
    expect(
      src.includes('ActionPrefix'),
      'view-api.ts must stop referencing ToolbarChannel.ActionPrefix',
    ).toBe(false)
    // And it must use the new Invoke channel.
    expect(
      src.includes('ToolbarChannel.Invoke'),
      'view-api.ts invokeToolbarAction must use ToolbarChannel.Invoke',
    ).toBe(true)
  })
})
