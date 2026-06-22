/**
 * HostToolbarControl gated narrow channel (MessagePort edition), MAIN-PROCESS
 * side.
 *
 * Contract under test:
 *
 *  - `hostToolbar.onMessage(channel, handler): Disposable` — CONTROL-level
 *    registration that survives toolbar page reloads / WC rebuilds (each new
 *    handshake re-attaches the registry to the new port). Empty/non-string
 *    channel throws. `dispose()` removes the handler; `disposeAll` sweeps all.
 *  - `hostToolbar.send(channel, payload): boolean` — false (NO queueing, NO
 *    view auto-creation) while there is no live toolbar WC or the current
 *    load's handshake hasn't completed; true once the envelope
 *    `{ channel, payload }` went out over the live MessagePortMain.
 *  - Handshake: on every toolbar-wc `did-finish-load` main creates a
 *    `new MessageChannelMain()`, transfers port2 via
 *    `wc.postMessage(HANDSHAKE_CHANNEL, null, [port2])`, keeps port1 and
 *    `start()`s it.
 *  - Close discipline: old port1 closes when a new handshake replaces it;
 *    `disposeAll` closes the active port; a port1 `'close'` event (renderer
 *    side gone — spike item 9) drops the reference so `send` reports false.
 *  - Inbound: port1 `'message'` events carry `{ data: { channel, payload } }`;
 *    malformed envelopes are DROPPED (no throw — toolbar content is
 *    host-arbitrary, same blast-radius posture as the sender-policy tests).
 *
 * IMPLEMENTATION SEAMS PINNED BY THIS FILE:
 *  - handshake channel literal: 'view:host-toolbar:port' (add as
 *    `ViewChannel.HostToolbarPort` in src/shared/ipc-channels.ts).
 *  - did-finish-load and destroyed hooks registered via `wc.on(...)` (the
 *    stub records `on`/`once`; the event-firing helper replays both).
 *
 * Electron mock mirrors host-toolbar.test.ts (private to this file — vitest
 * mocks are per-file, the shared convention in the sibling file is untouched)
 * and EXTENDS it with `MessageChannelMain` + `wc.postMessage`.
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

/** Electron MessagePortMain stand-in: spy methods + a real tiny emitter. */
type StubPortMain = {
  closed: boolean
  postMessage: ReturnType<typeof vi.fn>
  start: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  once: ReturnType<typeof vi.fn>
  off: ReturnType<typeof vi.fn>
  removeListener: ReturnType<typeof vi.fn>
  /** Test-only: fire listeners registered via on/once. */
  emit: (event: string, ...args: unknown[]) => void
}

const constructed: StubView[] = []
/** Every MessageChannelMain the implementation constructed, in order. */
const channels: Array<{ port1: StubPortMain; port2: StubPortMain }> = []

const mockFromId = vi.fn((_id: number) => null as unknown)

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
        // R2: the handshake transfers port2 via wc.postMessage(channel,
        // message, [port]); the spy records the transfer list.
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
    webContents: { fromId: (id: number) => mockFromId(id) },
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

/**
 * Handshake channel wire literal. The implementation must export it as
 * `ViewChannel.HostToolbarPort` with EXACTLY this value — preload and main
 * agree on the wire, so the test pins the literal, not the constant.
 */
const HANDSHAKE_CHANNEL = 'view:host-toolbar:port'

/** The R2 control-surface contract (not yet on HostToolbarControl). */
type Disposable = { dispose(): void }
type HostToolbarPortApi = {
  onMessage(channel: string, handler: (payload: unknown) => void): Disposable
  send(channel: string, payload: unknown): boolean
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
    mainWindow,
    addChildView,
    removeChildView,
    contentView,
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

/** The R2 surface, structurally cast (it does not exist on the type yet). */
function portApi(mgr: ReturnType<typeof createViewManager>): HostToolbarPortApi {
  return mgr.hostToolbar as unknown as HostToolbarPortApi
}

/**
 * Fire a webContents event the implementation subscribed to on the stub.
 * Replays both `on` and `once` registrations (seam: implementation should
 * use `wc.on('did-finish-load', …)` registered once at view creation).
 */
function fireWcEvent(view: StubView, event: string, ...args: unknown[]): void {
  const calls = [...view.webContents.on.mock.calls, ...view.webContents.once.mock.calls]
  for (const call of calls) {
    if (call[0] === event) (call[1] as AnyFn)(...args)
  }
}

/** Create the toolbar view via the public surface and complete one load. */
async function loadToolbar(mgr: ReturnType<typeof createViewManager>): Promise<StubView> {
  await mgr.hostToolbar.loadFile('/abs/toolbar.html')
  const view = constructed[constructed.length - 1]
  if (!view) throw new Error('loadFile did not construct a toolbar view')
  return view
}

describe('R2 handshake: did-finish-load → MessageChannelMain → wc.postMessage(port2) → port1.start()', () => {
  it('performs ONE handshake per finished load with the pinned wire shape', async () => {
    // BUG CAUGHT: no handshake (or wrong channel / no transfer) means the
    // preload never receives a port — the entire narrow channel is dead and
    // send() can never return true.
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)

    const view = await loadToolbar(mgr)
    fireWcEvent(view, 'did-finish-load')

    expect(channels.length).toBe(1)
    const ch = channels[0]!
    expect(view.webContents.postMessage).toHaveBeenCalledTimes(1)
    const [channel, message, transfer] = view.webContents.postMessage.mock.calls[0]! as [
      string,
      unknown,
      unknown[],
    ]
    expect(channel).toBe(HANDSHAKE_CHANNEL)
    expect(message).toBeNull()
    expect(transfer).toEqual([ch.port2])
    // port1 stays in main and must be started or its 'message' events never flow.
    expect(ch.port1.start).toHaveBeenCalled()
  })

  it('does NOT hand a port to a document that has not finished loading', async () => {
    // BUG CAUGHT: posting the port at load-START (or at view creation) races
    // the navigation — the port lands in the OLD document and dies with it
    // (the reload race the per-load handshake exists to avoid).
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)

    await loadToolbar(mgr)

    expect(channels.length).toBe(0)
    const view = constructed[0]!
    expect(view.webContents.postMessage).not.toHaveBeenCalled()
  })
})

describe('R2 send(): gated, non-queueing, non-creating', () => {
  it('returns false before any toolbar view exists and does NOT auto-create one', () => {
    // BUG CAUGHT: send() lazily constructing the WCV would materialize a
    // toolbar strip the host never asked for (loadURL/loadFile/bounds are the
    // only sanctioned creation paths).
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)

    expect(portApi(mgr).send('chan', { a: 1 })).toBe(false)
    expect(constructed.length).toBe(0)
  })

  it('returns false between load start and handshake, and the payload is NOT queued/flushed later', async () => {
    // BUG CAUGHT: silently queueing a false-returning send would deliver
    // messages the caller believes were dropped — the contract is
    // "false = not delivered, ever".
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)
    const view = await loadToolbar(mgr)

    expect(portApi(mgr).send('chan', { early: true })).toBe(false)

    fireWcEvent(view, 'did-finish-load')
    expect(channels.length).toBe(1)
    // The pre-handshake payload must not surface on the fresh port.
    expect(channels[0]!.port1.postMessage).not.toHaveBeenCalled()
  })

  it('after the handshake: returns true and posts the {channel, payload} envelope on port1', async () => {
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)
    const view = await loadToolbar(mgr)
    fireWcEvent(view, 'did-finish-load')

    const ok = portApi(mgr).send('host:cmd', { a: 1 })

    expect(ok).toBe(true)
    const port1 = channels[0]!.port1
    expect(port1.postMessage).toHaveBeenCalledTimes(1)
    expect(port1.postMessage).toHaveBeenCalledWith({ channel: 'host:cmd', payload: { a: 1 } })
  })

  it("port1 'close' (renderer side died, no re-handshake yet): send returns false, nothing posted to the dead port", async () => {
    // BUG CAUGHT: spike item 9 — after the renderer goes away the main-side
    // port emits 'close'. An implementation that keeps the stale reference
    // would return true while posting into a dead port (silent message loss
    // reported as success).
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)
    const view = await loadToolbar(mgr)
    fireWcEvent(view, 'did-finish-load')
    const port1 = channels[0]!.port1

    port1.emit('close')

    expect(portApi(mgr).send('chan', 'x')).toBe(false)
    expect(port1.postMessage).not.toHaveBeenCalled()
  })
})

describe('R2 inbound: port1 message envelopes → control-level onMessage registry', () => {
  it('a handler registered BEFORE the view even exists receives a post-handshake page message', async () => {
    // Pins the CONTROL-level registry: registration must not require a live
    // port (or even a view) at call time.
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)
    const got: unknown[] = []
    portApi(mgr).onMessage('page:evt', (payload) => { got.push(payload) })

    const view = await loadToolbar(mgr)
    fireWcEvent(view, 'did-finish-load')
    channels[0]!.port1.emit('message', { data: { channel: 'page:evt', payload: 7 } })

    expect(got).toEqual([7])
  })

  it('malformed envelopes from the (host-arbitrary) toolbar page are dropped without throwing', async () => {
    // BUG CAUGHT: the toolbar page is untrusted host content; a crafted
    // postMessage(null) etc. must not crash the main process dispatcher.
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)
    const handler = vi.fn()
    portApi(mgr).onMessage('page:evt', handler)
    const view = await loadToolbar(mgr)
    fireWcEvent(view, 'did-finish-load')
    const port1 = channels[0]!.port1

    for (const data of [null, undefined, 'page:evt', 42, {}, { payload: 1 }, { channel: 99 }]) {
      expect(() => port1.emit('message', { data })).not.toThrow()
    }
    expect(handler).not.toHaveBeenCalled()
  })

  it('routes by channel: a handler on another channel is not invoked', async () => {
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)
    const a = vi.fn()
    const b = vi.fn()
    portApi(mgr).onMessage('a', a)
    portApi(mgr).onMessage('b', b)
    const view = await loadToolbar(mgr)
    fireWcEvent(view, 'did-finish-load')

    channels[0]!.port1.emit('message', { data: { channel: 'b', payload: 'x' } })

    expect(a).not.toHaveBeenCalled()
    expect(b).toHaveBeenCalledExactlyOnceWith('x')
  })

  it('multiple handlers on one channel all receive the payload', async () => {
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)
    const h1 = vi.fn()
    const h2 = vi.fn()
    portApi(mgr).onMessage('evt', h1)
    portApi(mgr).onMessage('evt', h2)
    const view = await loadToolbar(mgr)
    fireWcEvent(view, 'did-finish-load')

    channels[0]!.port1.emit('message', { data: { channel: 'evt', payload: 1 } })

    expect(h1).toHaveBeenCalledExactlyOnceWith(1)
    expect(h2).toHaveBeenCalledExactlyOnceWith(1)
  })

  it('Disposable.dispose() detaches the handler (idempotent)', async () => {
    // BUG CAUGHT: a leaked handler keeps firing for a host that unsubscribed —
    // the classic listener-leak this Disposable shape exists to prevent.
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)
    const handler = vi.fn()
    const sub = portApi(mgr).onMessage('evt', handler)
    const view = await loadToolbar(mgr)
    fireWcEvent(view, 'did-finish-load')

    sub.dispose()
    channels[0]!.port1.emit('message', { data: { channel: 'evt', payload: 1 } })

    expect(handler).not.toHaveBeenCalled()
    expect(() => sub.dispose()).not.toThrow()
  })

  it('onMessage validates the channel: empty string / non-string throw, a valid one does not', () => {
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)
    const toolbar = portApi(mgr)

    // Guard first so the throw-assertions below cannot pass vacuously via a
    // TypeError from a missing method.
    expect(typeof toolbar.onMessage).toBe('function')

    expect(() => toolbar.onMessage('', () => {})).toThrow()
    expect(() => toolbar.onMessage(123 as unknown as string, () => {})).toThrow()
    expect(() => toolbar.onMessage('ok', () => {}).dispose()).not.toThrow()
  })
})

describe('R2 reload lifecycle: re-handshake, handler survival, old-port close discipline', () => {
  it('a second did-finish-load closes the old port1, opens a fresh channel, and existing handlers keep receiving', async () => {
    // THE core R2 scenario: toolbar page reloads. BUG CAUGHT: per-port handler
    // attachment (handlers die with the old port and the host silently stops
    // hearing its own toolbar after every reload).
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)
    const got: unknown[] = []
    portApi(mgr).onMessage('evt', (payload) => { got.push(payload) })
    const view = await loadToolbar(mgr)

    fireWcEvent(view, 'did-finish-load')
    channels[0]!.port1.emit('message', { data: { channel: 'evt', payload: 'load-1' } })

    // Reload: same wc finishes a second load.
    fireWcEvent(view, 'did-finish-load')

    expect(channels.length).toBe(2)
    // Close discipline: the replaced port1 must be closed.
    expect(channels[0]!.port1.close).toHaveBeenCalled()
    // Fresh port2 transferred for the new document.
    expect(view.webContents.postMessage).toHaveBeenCalledTimes(2)
    const [, , transfer2] = view.webContents.postMessage.mock.calls[1]! as [string, unknown, unknown[]]
    expect(transfer2).toEqual([channels[1]!.port2])

    // The SAME registration (no re-subscribe) hears the new load.
    channels[1]!.port1.emit('message', { data: { channel: 'evt', payload: 'load-2' } })
    expect(got).toEqual(['load-1', 'load-2'])
  })

  it('send after a re-handshake goes out on the NEW port1 only', async () => {
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)
    const view = await loadToolbar(mgr)
    fireWcEvent(view, 'did-finish-load')
    fireWcEvent(view, 'did-finish-load')

    const ok = portApi(mgr).send('chan', 'fresh')

    expect(ok).toBe(true)
    expect(channels[1]!.port1.postMessage).toHaveBeenCalledExactlyOnceWith({
      channel: 'chan',
      payload: 'fresh',
    })
    expect(channels[0]!.port1.postMessage).not.toHaveBeenCalled()
  })
})

describe('R2 disposeAll: closes the live port and sweeps the registry', () => {
  it('disposeAll closes port1; send then reports false; late dispose() of a handler does not throw', async () => {
    // BUG CAUGHT: a port surviving disposeAll keeps a renderer-linked handle
    // alive across manager teardown (the exact leak class the teardown sweep
    // exists for — see view-manager-connection-teardown.test.ts).
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)
    const sub = portApi(mgr).onMessage('evt', vi.fn())
    const view = await loadToolbar(mgr)
    fireWcEvent(view, 'did-finish-load')
    const port1 = channels[0]!.port1

    mgr.disposeAll()

    expect(port1.close).toHaveBeenCalled()
    expect(portApi(mgr).send('chan', 1)).toBe(false)
    expect(port1.postMessage).not.toHaveBeenCalled()
    expect(() => sub.dispose()).not.toThrow()
  })
})
