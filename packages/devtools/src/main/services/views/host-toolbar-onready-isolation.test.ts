/**
 * onReady handler EXCEPTION ISOLATION. Without it (host-toolbar-port-channel.ts):
 *
 *  - normal fire path (`fireReadyHandlers`, :179): handlers run bare inside a
 *    plain for-loop — one handler throwing ABORTS the loop (later-registered
 *    handlers are silently skipped for that generation) AND the exception
 *    propagates out of `handshake()` into the `did-finish-load` event
 *    callback, i.e. into Electron's emitter → process-level crash territory;
 *  - catch-up path (`onReady` registration while ready, :282): the scheduled
 *    `entry.handler()` runs bare inside `queueMicrotask` — a throw escapes the
 *    microtask boundary, which in Node is an `uncaughtException` (default:
 *    process crash).
 *
 * Locked contract (this file is the spec):
 *  - one onReady handler throwing must NOT prevent any other registered
 *    handler from firing — on BOTH paths (handshake fire, already-ready
 *    catch-up);
 *  - the throw must NOT escape the event/microtask callback boundary: the
 *    `did-finish-load` listener must not throw, and no `uncaughtException`
 *    may surface from a catch-up fire;
 *  - a throwing handler must not corrupt the channel: the handshake still
 *    completes (`send` → true) and the next generation still fires handlers.
 *
 * Electron mock + harness: copied from host-toolbar-onready.test.ts (vitest
 * mocks are per-file; main-process suites must vi.mock('electron')).
 *
 * Guards isolation on both paths: a failing handler must not skip its sibling
 * and must not let the exception escape.
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

/**
 * Run `body` with process 'uncaughtException' listeners swapped for a capture
 * sink, so a throw escaping a `queueMicrotask` callback (Node surfaces those
 * as 'uncaughtException', NOT 'unhandledRejection') is observable by the test
 * instead of being attributed by vitest's own process-level handlers.
 */
async function captureUncaught(body: () => Promise<void>): Promise<unknown[]> {
  const prior = process.listeners('uncaughtException')
  process.removeAllListeners('uncaughtException')
  const escaped: unknown[] = []
  const capture: NodeJS.UncaughtExceptionListener = (err) => { escaped.push(err) }
  process.on('uncaughtException', capture)
  try {
    await body()
  } finally {
    process.removeListener('uncaughtException', capture)
    for (const l of prior) process.on('uncaughtException', l)
  }
  return escaped
}

describe('① normal fire path: one throwing handler must not break siblings or escape', () => {
  it('A throws on handshake fire → B still fires once, and nothing escapes the did-finish-load callback', async () => {
    // BUG CAUGHT (today): fireReadyHandlers runs handlers bare in a for-loop —
    // A's throw aborts the loop (B never hears the handshake) and propagates
    // out of the did-finish-load listener (in real Electron: an exception in
    // an EventEmitter callback on the main process).
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)
    const b = vi.fn()
    mgr.hostToolbar.onReady(() => { throw new Error('boom-fire') })
    mgr.hostToolbar.onReady(b)
    const view = await loadToolbar(mgr)

    let escapedFromEvent: unknown = null
    try {
      fireWcEvent(view, 'did-finish-load')
    } catch (err) {
      escapedFromEvent = err
    }

    expect(
      escapedFromEvent,
      'a handler throw must not escape the did-finish-load event callback',
    ).toBeNull()
    expect(b, 'handler registered after the throwing one must still fire').toHaveBeenCalledTimes(1)

    // The throw must not corrupt the channel either: the handshake completed,
    // so send() reports deliverable.
    expect(mgr.hostToolbar.send('post-throw-probe', null)).toBe(true)
  })

  it('a throwing handler does not poison subsequent generations (B fires again on reload)', async () => {
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)
    const b = vi.fn()
    mgr.hostToolbar.onReady(() => { throw new Error('boom-every-generation') })
    mgr.hostToolbar.onReady(b)
    const view = await loadToolbar(mgr)

    try { fireWcEvent(view, 'did-finish-load') } catch { /* RED-phase escape */ }
    try { fireWcEvent(view, 'did-finish-load') } catch { /* RED-phase escape */ }

    expect(b, 'sibling must fire once per generation despite the throw').toHaveBeenCalledTimes(2)
  })
})

describe('① catch-up path: a throwing late registration must not escape the microtask or starve siblings', () => {
  it('A (throws) and B registered while READY → B still catch-up-fires, and no uncaughtException surfaces', async () => {
    // BUG CAUGHT (today): the catch-up runs `entry.handler()` bare inside
    // queueMicrotask — A's throw escapes the microtask boundary, which is a
    // process-level uncaughtException (default behavior: crash the app).
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)
    const view = await loadToolbar(mgr)
    fireWcEvent(view, 'did-finish-load')
    await flushMicrotasks()

    const b = vi.fn()
    const escaped = await captureUncaught(async () => {
      mgr.hostToolbar.onReady(() => { throw new Error('boom-catchup') })
      mgr.hostToolbar.onReady(b)
      await flushMicrotasks()
    })

    expect(b, 'sibling catch-up must still fire').toHaveBeenCalledTimes(1)
    expect(
      escaped,
      'a catch-up handler throw must not escape the microtask as an uncaughtException',
    ).toEqual([])

    // Channel unharmed: still ready, still deliverable.
    expect(mgr.hostToolbar.send('post-throw-probe', null)).toBe(true)
  })

  it('handshake-fire throw does not escape as a deferred uncaughtException either', async () => {
    // Companion guard for the fire path: even if an implementation defers the
    // handler invocation, the throw must never surface at process level.
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)
    mgr.hostToolbar.onReady(() => { throw new Error('boom-fire-deferred') })
    const view = await loadToolbar(mgr)

    const escaped = await captureUncaught(async () => {
      try {
        fireWcEvent(view, 'did-finish-load')
      } catch {
        /* synchronous escape is pinned by the first suite; here we only
           collect process-level escapes */
      }
      await flushMicrotasks()
    })

    expect(escaped).toEqual([])
  })
})
