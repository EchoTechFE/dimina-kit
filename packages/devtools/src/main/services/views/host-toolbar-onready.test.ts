/**
 * Feedback fix ③ — the host-toolbar handshake must be OBSERVABLE.
 *
 * Today's bug, verified against source: the per-load MessagePort handshake
 * (host-toolbar-port-channel.ts `handshake()`) completes silently. The only
 * readiness probe a host has is polling `send()` for `true` — there is no
 * event, so "send the toolbar its initial state as soon as it can hear me"
 * forces every host into a retry loop.
 *
 * Locked contract (this file is the spec) — `HostToolbarControl` gains:
 *
 *   onReady(handler: () => void): { dispose(): void }
 *
 *  - fires the handler ONCE per load generation, when that load's MessagePort
 *    handshake completes (i.e. exactly when `send` flips to true);
 *  - registering while the channel is ALREADY ready fires the handler once
 *    asynchronously on a microtask (the missed-signal race guard: a host that
 *    subscribes "too late" still gets its signal) — never synchronously
 *    inside onReady();
 *  - a reload / re-handshake fires registered handlers again (next
 *    generation);
 *  - a host-initiated loadURL/loadFile INVALIDATES readiness (the port is
 *    dropped at initiation) — a handler registered in that window must wait
 *    for the new document's handshake, not catch-up-fire for the dead one;
 *  - `dispose()` detaches (idempotent); `disposeAll` sweeps everything.
 *
 * Electron mock + harness: copied from host-toolbar-port-channel.test.ts
 * (vitest mocks are per-file; main-process suites must vi.mock('electron')).
 *
 * RED today: `onReady` does not exist on the control surface — the typeof
 * guard in every test fails first.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type AnyFn = (...args: unknown[]) => unknown

type StubWebContents = {
  destroyed: boolean
  id: number
  isDestroyed: () => boolean
  close: ReturnType<typeof vi.fn>
  loadFile: ReturnType<typeof vi.fn>
  loadURL: ReturnType<typeof vi.fn>
  postMessage: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  once: ReturnType<typeof vi.fn>
  setWindowOpenHandler: ReturnType<typeof vi.fn>
}
type StubView = {
  webContents: StubWebContents
  setBounds: ReturnType<typeof vi.fn>
  setBackgroundColor: ReturnType<typeof vi.fn>
}

type StubPortMain = {
  closed: boolean
  postMessage: ReturnType<typeof vi.fn>
  start: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  once: ReturnType<typeof vi.fn>
  off: ReturnType<typeof vi.fn>
  removeListener: ReturnType<typeof vi.fn>
  emit: (event: string, ...args: unknown[]) => void
}

const constructed: StubView[] = []
const channels: Array<{ port1: StubPortMain; port2: StubPortMain }> = []

function makeStubPortMain(): StubPortMain {
  const listeners = new Map<string, AnyFn[]>()
  const add = (ev: string, fn: AnyFn) => {
    const arr = listeners.get(ev) ?? []
    arr.push(fn)
    listeners.set(ev, arr)
  }
  const remove = (ev: string, fn: AnyFn) => {
    const arr = listeners.get(ev) ?? []
    const i = arr.indexOf(fn)
    if (i >= 0) arr.splice(i, 1)
  }
  const port: StubPortMain = {
    closed: false,
    postMessage: vi.fn(),
    start: vi.fn(),
    close: vi.fn(() => { port.closed = true }),
    on: vi.fn((ev: string, fn: AnyFn) => { add(ev, fn); return port }),
    once: vi.fn((ev: string, fn: AnyFn) => {
      const wrap: AnyFn = (...a) => { remove(ev, wrap); return fn(...a) }
      add(ev, wrap)
      return port
    }),
    off: vi.fn((ev: string, fn: AnyFn) => { remove(ev, fn); return port }),
    removeListener: vi.fn((ev: string, fn: AnyFn) => { remove(ev, fn); return port }),
    emit: (ev, ...args) => {
      for (const fn of [...(listeners.get(ev) ?? [])]) fn(...args)
    },
  }
  return port
}

vi.mock('electron', () => {
  let nextId = 1
  class WebContentsView {
    webContents: StubWebContents
    setBounds = vi.fn()
    setBackgroundColor = vi.fn()
    constructor() {
      const id = nextId++
      this.webContents = {
        destroyed: false,
        id,
        isDestroyed() { return this.destroyed },
        close: vi.fn(function (this: StubWebContents) { this.destroyed = true }),
        loadFile: vi.fn(() => Promise.resolve()),
        loadURL: vi.fn(() => Promise.resolve()),
        postMessage: vi.fn(),
        on: vi.fn(),
        once: vi.fn(),
        setWindowOpenHandler: vi.fn(),
      }
      constructed.push(this as unknown as StubView)
    }
  }
  class MessageChannelMain {
    port1 = makeStubPortMain()
    port2 = makeStubPortMain()
    constructor() {
      channels.push(this as unknown as { port1: StubPortMain; port2: StubPortMain })
    }
  }
  return {
    WebContentsView,
    MessageChannelMain,
    webContents: { fromId: vi.fn(() => null) },
    ipcMain: { on: vi.fn(), removeListener: vi.fn() },
    shell: { openExternal: vi.fn() },
    session: {
      defaultSession: {
        registerPreloadScript: vi.fn(() => 'stub-preload-script-id'),
        unregisterPreloadScript: vi.fn(),
      },
    },
  }
})

vi.mock('../../utils/paths.js', () => ({
  mainPreloadPath: '/stub/preload.js',
  hostToolbarRuntimePreloadPath: '/stub/host-toolbar-runtime-preload.cjs',
  cjsSiblingPreloadPath: (p: string) => p,
  devtoolsPackageRoot: '/stub/devtools-pkg-root',
}))

// Import AFTER mocks so view-manager picks up the stubs.
import { createViewManager } from './view-manager.js'
import { createConnectionRegistry } from '@dimina-kit/electron-deck/main'

/** The ③ control-surface contract (not on HostToolbarControl yet). */
type Disposable = { dispose(): void }
type HostToolbarOnReadyApi = {
  onReady(handler: () => void): Disposable
}

function makeContext() {
  const addChildView = vi.fn()
  const removeChildView = vi.fn()
  const contentView = { addChildView, removeChildView, children: [] }
  const mainWindow = {
    destroyed: false,
    contentView,
    isDestroyed() { return this.destroyed },
    getContentSize: () => [1280, 980],
  }
  const notify = {
    popoverInit: vi.fn(),
    popoverClosed: vi.fn(),
    hostToolbarHeightChanged: vi.fn(),
  }
  return {
    notify,
    ctx: {
      windows: {
        mainWindow: mainWindow as unknown as import('electron').BrowserWindow,
      } as import('../window-service.js').WindowService,
      rendererDir: '/stub/renderer',
      panels: ['console', 'wxml', 'storage', 'appdata'],
      notify: notify as unknown as import('../notifications/renderer-notifier.js').RendererNotifier,
      connections: createConnectionRegistry(),
    },
  }
}

beforeEach(() => {
  constructed.length = 0
  channels.length = 0
})

/** The ③ surface, structurally cast (it does not exist on the type yet). */
function readyApi(mgr: ReturnType<typeof createViewManager>): HostToolbarOnReadyApi {
  return mgr.hostToolbar as unknown as HostToolbarOnReadyApi
}

function fireWcEvent(view: StubView, event: string, ...args: unknown[]): void {
  const calls = [...view.webContents.on.mock.calls, ...view.webContents.once.mock.calls]
  for (const call of calls) {
    if (call[0] === event) (call[1] as AnyFn)(...args)
  }
}

async function loadToolbar(mgr: ReturnType<typeof createViewManager>): Promise<StubView> {
  await mgr.hostToolbar.loadFile('/abs/toolbar.html')
  const view = constructed[constructed.length - 1]
  if (!view) throw new Error('loadFile did not construct a toolbar view')
  return view
}

/** Drain the microtask queue (generously) without entering the macrotask loop. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('③ onReady exists on the control surface', () => {
  it('hostToolbar.onReady is a function returning a Disposable', () => {
    // BUG CAUGHT (today's gap): the handshake completes silently — the only
    // readiness signal is polling send() for true, so hosts ship retry loops.
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)
    const toolbar = readyApi(mgr)

    expect(typeof toolbar.onReady).toBe('function')
    const sub = toolbar.onReady(() => {})
    expect(typeof sub.dispose).toBe('function')
    sub.dispose()
  })
})

describe('③ onReady fires on handshake completion (one shot per load generation)', () => {
  it('does NOT fire before the handshake (load started, did-finish-load not yet)', async () => {
    // BUG CAUGHT: firing at load START (or at registration) tells the host
    // the channel is open while send() still returns false — the host's
    // "initial state" message is silently dropped.
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)
    const handler = vi.fn()
    readyApi(mgr).onReady(handler)

    await loadToolbar(mgr)
    await flushMicrotasks()

    expect(handler).not.toHaveBeenCalled()
  })

  it('fires every registered handler exactly once when the handshake completes', async () => {
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)
    const h1 = vi.fn()
    const h2 = vi.fn()
    readyApi(mgr).onReady(h1)
    readyApi(mgr).onReady(h2)
    const view = await loadToolbar(mgr)

    fireWcEvent(view, 'did-finish-load')
    await flushMicrotasks()

    expect(h1).toHaveBeenCalledTimes(1)
    expect(h2).toHaveBeenCalledTimes(1)

    // One shot PER GENERATION: no spurious re-fire without a new handshake.
    await flushMicrotasks()
    expect(h1).toHaveBeenCalledTimes(1)
  })

  it('when ready, send() already reports true from inside the handler (ordering pin)', async () => {
    // BUG CAUGHT: an onReady that fires BEFORE the port is live would hand
    // the host a signal it cannot act on — the entire point is "you may send
    // now".
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)
    const sendResults: boolean[] = []
    readyApi(mgr).onReady(() => {
      sendResults.push(mgr.hostToolbar.send('ready-probe', null))
    })
    const view = await loadToolbar(mgr)

    fireWcEvent(view, 'did-finish-load')
    await flushMicrotasks()

    expect(sendResults).toEqual([true])
  })
})

describe('③ late registration: already-ready catch-up fire (missed-signal race guard)', () => {
  it('registering AFTER the handshake fires the handler once on a microtask, never synchronously', async () => {
    // BUG CAUGHT: without the catch-up fire, a host that subscribes after the
    // (racy, load-driven) handshake waits forever — the exact missed-signal
    // race onReady exists to close. The fire must be ASYNC so registration
    // never re-enters host code synchronously.
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)
    const view = await loadToolbar(mgr)
    fireWcEvent(view, 'did-finish-load')

    const handler = vi.fn()
    readyApi(mgr).onReady(handler)

    expect(handler, 'catch-up fire must not run synchronously inside onReady()').not.toHaveBeenCalled()
    await flushMicrotasks()
    expect(handler).toHaveBeenCalledTimes(1)

    // Catch-up is ONE shot — no duplicate later.
    await flushMicrotasks()
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('registering after a host-initiated loadFile (port invalidated) waits for the NEW handshake — no stale catch-up', async () => {
    // BUG CAUGHT: a "ready latch" that is set once and never cleared. After
    // loadURL/loadFile the port is invalidated at initiation (send() === false),
    // so a catch-up fire here would signal readiness for a DEAD document.
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)
    const view = await loadToolbar(mgr)
    fireWcEvent(view, 'did-finish-load')

    // Host starts a new load: readiness must drop with the port.
    await mgr.hostToolbar.loadFile('/abs/toolbar-v2.html')
    const handler = vi.fn()
    readyApi(mgr).onReady(handler)
    await flushMicrotasks()

    expect(handler, 'no catch-up fire while the navigation is in flight').not.toHaveBeenCalled()

    // The new document's handshake delivers the (single) fire.
    fireWcEvent(view, 'did-finish-load')
    await flushMicrotasks()
    expect(handler).toHaveBeenCalledTimes(1)
  })
})

describe('③ reload: a new load generation fires again', () => {
  it('a second did-finish-load (page reload) re-fires registered handlers', async () => {
    // BUG CAUGHT: a one-shot-forever onReady. After a toolbar reload the host
    // must re-push its state; without the per-generation re-fire it never
    // hears that the new document is listening.
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)
    const handler = vi.fn()
    readyApi(mgr).onReady(handler)
    const view = await loadToolbar(mgr)

    fireWcEvent(view, 'did-finish-load')
    await flushMicrotasks()
    expect(handler).toHaveBeenCalledTimes(1)

    fireWcEvent(view, 'did-finish-load')
    await flushMicrotasks()
    expect(handler).toHaveBeenCalledTimes(2)
  })
})

describe('③ dispose semantics', () => {
  it('dispose() before the handshake detaches the handler (and is idempotent)', async () => {
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)
    const handler = vi.fn()
    const sub = readyApi(mgr).onReady(handler)

    sub.dispose()
    const view = await loadToolbar(mgr)
    fireWcEvent(view, 'did-finish-load')
    await flushMicrotasks()

    expect(handler).not.toHaveBeenCalled()
    expect(() => sub.dispose()).not.toThrow()
  })

  it('dispose() after a fire stops subsequent generations', async () => {
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)
    const handler = vi.fn()
    const sub = readyApi(mgr).onReady(handler)
    const view = await loadToolbar(mgr)

    fireWcEvent(view, 'did-finish-load')
    await flushMicrotasks()
    expect(handler).toHaveBeenCalledTimes(1)

    sub.dispose()
    fireWcEvent(view, 'did-finish-load')
    await flushMicrotasks()
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('disposeAll sweeps onReady registrations (no fire on a late did-finish-load, late dispose() is a no-op)', async () => {
    // BUG CAUGHT: handlers surviving manager teardown — the same leak class
    // the disposeAll sweep already covers for onMessage subscriptions.
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)
    const handler = vi.fn()
    const sub = readyApi(mgr).onReady(handler)
    const view = await loadToolbar(mgr)
    fireWcEvent(view, 'did-finish-load')
    await flushMicrotasks()
    expect(handler).toHaveBeenCalledTimes(1)

    mgr.disposeAll()

    // A stale wc event after teardown must not resurrect the signal.
    fireWcEvent(view, 'did-finish-load')
    await flushMicrotasks()
    expect(handler).toHaveBeenCalledTimes(1)
    expect(() => sub.dispose()).not.toThrow()

    // Registering on the torn-down control never fires (inert, not throwing).
    const late = vi.fn()
    expect(() => readyApi(mgr).onReady(late)).not.toThrow()
    await flushMicrotasks()
    expect(late).not.toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// INCREMENTAL ROUND (③ 增量) — the scheduled catch-up fire must RE-CHECK its
// preconditions AT FIRE TIME, not only at registration time.
//
// The first wave pinned the catch-up as async-on-a-microtask and pinned that
// a dispose()/loadFile happening BEFORE registration suppresses it. The
// Claude×codex final review found the remaining hole: the window BETWEEN
// registration (catch-up scheduled) and the microtask (catch-up runs). Both
// the subscription's liveness and the load generation can change inside that
// window; a catch-up that snapshots only at registration fires stale. Not
// covered above — these two interleavings did not exist in the first wave.
// ═══════════════════════════════════════════════════════════════════════════

describe('③(增量) same-frame dispose(): catch-up re-checks subscription liveness at fire time', () => {
  it('onReady(h) while READY then dispose() in the same frame → h never fires', async () => {
    // BUG CAUGHT: a catch-up implemented as `queueMicrotask(() => handler())`
    // captures the handler at registration — a same-frame dispose() is then
    // ignored and the host's "I unsubscribed" guarantee is broken exactly
    // once, on the hardest-to-reproduce path.
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)
    const view = await loadToolbar(mgr)
    fireWcEvent(view, 'did-finish-load')
    await flushMicrotasks()

    const handler = vi.fn()
    const sub = readyApi(mgr).onReady(handler) // ready ⇒ catch-up scheduled
    sub.dispose() // same frame, before the microtask runs

    await flushMicrotasks()
    expect(handler, 'disposed-before-fire handler must not receive the catch-up').not.toHaveBeenCalled()

    // And the dead subscription stays dead across the next generation.
    fireWcEvent(view, 'did-finish-load')
    await flushMicrotasks()
    expect(handler).not.toHaveBeenCalled()
  })
})

describe('③(增量) same-frame loadFile: catch-up re-checks the load generation at fire time', () => {
  it('registered while ready, loadFile initiated in the same frame → no stale catch-up; the NEW handshake delivers the single fire', async () => {
    // BUG CAUGHT: the catch-up decides "we are ready" at registration; a
    // host-initiated loadFile in the same frame invalidates the port
    // synchronously at initiation (send() === false), so a catch-up that
    // still fires signals readiness for a DEAD document — the host's initial
    // state goes into the void and is never re-sent.
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)
    const view = await loadToolbar(mgr)
    fireWcEvent(view, 'did-finish-load')
    await flushMicrotasks()

    const handler = vi.fn()
    readyApi(mgr).onReady(handler) // ready ⇒ catch-up scheduled
    const navigation = mgr.hostToolbar.loadFile('/abs/toolbar-v2.html') // same frame: invalidates at initiation

    await navigation
    await flushMicrotasks()
    expect(handler, 'no catch-up for the document the in-flight load is replacing').not.toHaveBeenCalled()

    // The new document's handshake delivers the (single) fire.
    fireWcEvent(view, 'did-finish-load')
    await flushMicrotasks()
    expect(handler).toHaveBeenCalledTimes(1)
  })
})
