/**
 * Navigation-window violation of the send() three-state contract. If the
 * channel cleared its active port ONLY on (a) the next did-finish-load
 * handshake, (b) wc 'destroyed', (c) remote port 'close' — so that starting a
 * NEW navigation invalidated nothing — then:
 *
 *   - host calls hostToolbar.loadURL/loadFile and a same-tick send() still
 *     returns TRUE — the envelope is posted into the OLD document that is
 *     about to be torn down. Downstream believes "delivered" while the
 *     message dies with the replaced page (silent loss reported as success,
 *     the exact failure mode send():false exists to make visible);
 *   - page-initiated navigation (location.href / reload) has the same window
 *     between did-start-navigation and did-finish-load.
 *
 * CONTRACT PINNED BY THIS FILE:
 *  a) HOST-INITIATED: hostToolbar.loadURL / hostToolbar.loadFile invalidate
 *     the active port AT INITIATION, synchronously (close + drop). send()
 *     returns false from the same tick the load call is issued until the new
 *     load's did-finish-load handshake completes, then true again on the
 *     FRESH port only.
 *  b) PAGE-INITIATED: a main-frame, cross-document 'did-start-navigation'
 *     invalidates the port (send() → false) until the next handshake.
 *     IN-PLACE navigations (isSameDocument: anchors, pushState, same-page
 *     history) and SUBFRAME navigations must NOT invalidate — the document
 *     the port lives in survives those.
 *  c) A STALE wc's late 'did-start-navigation' (after a rebuild swapped the
 *     view) must not drop the successor's port — same activeWc discipline as
 *     the existing 'destroyed' handler.
 *
 * DID-START-NAVIGATION STUB SHAPE (read from electron@41 electron.d.ts,
 * WebContents['on']): listener receives
 *   (details: Event<WebContentsDidStartNavigationEventParams>,
 *    url: string /\* deprecated *\/, isInPlace: boolean /\* deprecated *\/,
 *    isMainFrame: boolean /\* deprecated *\/, frameProcessId, frameRoutingId)
 * where details = { url, isSameDocument, isMainFrame, frame, initiator } plus
 * Event members (preventDefault, defaultPrevented). This file replays the
 * FULL real signature — details object first, deprecated positional args
 * after — so the implementation may read either form.
 *
 * Electron mock / harness conventions mirror host-toolbar-port-channel.test.ts
 * (vitest mocks are per-file; the sibling file is untouched).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type AnyFn = (...args: unknown[]) => unknown

type StubWebContents = {
  destroyed: boolean
  id: number
  isDestroyed: () => boolean
  close: ReturnType<typeof vi.fn> & (() => void)
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

/**
 * Fire a webContents event the implementation subscribed to on the stub.
 * Replays both `on` and `once` registrations.
 */
function fireWcEvent(view: StubView, event: string, ...args: unknown[]): void {
  const calls = [...view.webContents.on.mock.calls, ...view.webContents.once.mock.calls]
  for (const call of calls) {
    if (call[0] === event) (call[1] as AnyFn)(...args)
  }
}

/**
 * Replay 'did-start-navigation' with the REAL electron@41 listener signature:
 * (details-Event, url, isInPlace, isMainFrame, frameProcessId, frameRoutingId).
 * `isInPlace` (deprecated positional) === details.isSameDocument.
 */
function fireDidStartNavigation(
  view: StubView,
  opts: { url: string; isSameDocument?: boolean; isMainFrame?: boolean },
): void {
  const details = {
    url: opts.url,
    isSameDocument: opts.isSameDocument ?? false,
    isMainFrame: opts.isMainFrame ?? true,
    frame: null,
    initiator: null,
    defaultPrevented: false,
    preventDefault: vi.fn(),
  }
  fireWcEvent(
    view,
    'did-start-navigation',
    details,
    details.url,
    details.isSameDocument,
    details.isMainFrame,
    7, // frameProcessId (deprecated)
    1, // frameRoutingId (deprecated)
  )
}

/** Create the toolbar view via the public surface and complete one load+handshake. */
async function loadAndHandshake(mgr: ReturnType<typeof createViewManager>): Promise<StubView> {
  await mgr.hostToolbar.loadFile('/abs/toolbar.html')
  const view = constructed[constructed.length - 1]
  if (!view) throw new Error('loadFile did not construct a toolbar view')
  fireWcEvent(view, 'did-finish-load')
  return view
}

describe('Bug 1a — HOST-INITIATED loads invalidate the port AT INITIATION', () => {
  it('loadURL: a same-tick send() after issuing the load returns false and posts NOTHING to the old port', async () => {
    // BUG CAUGHT (the MAJOR): today this send() returns true and the envelope
    // lands in the document loadURL is about to replace — the caller is told
    // "delivered" for a message no document will ever consume.
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)
    const view = await loadAndHandshake(mgr)
    const oldPort1 = channels[0]!.port1
    expect(mgr.hostToolbar.send('warm-up', 1)).toBe(true) // sanity: channel was live
    expect(oldPort1.postMessage).toHaveBeenCalledTimes(1)

    void mgr.hostToolbar.loadURL('https://host.example/next') // NOT awaited — same tick

    expect(mgr.hostToolbar.send('chan', { lost: true })).toBe(false)
    expect(oldPort1.postMessage).toHaveBeenCalledTimes(1) // still only the warm-up
    expect(view.webContents.loadURL).toHaveBeenCalledWith('https://host.example/next')
  })

  it('loadFile: same initiation-invalidates contract', async () => {
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)
    await loadAndHandshake(mgr)
    const oldPort1 = channels[0]!.port1

    void mgr.hostToolbar.loadFile('/abs/next.html') // NOT awaited — same tick

    expect(mgr.hostToolbar.send('chan', 'x')).toBe(false)
    expect(oldPort1.postMessage).not.toHaveBeenCalled()
  })

  it('loadURL initiation CLOSES the replaced port (close discipline, not just a dropped reference)', async () => {
    // BUG CAUGHT: dropping the reference without close() leaks the main-side
    // port handle until GC and the renderer end never observes 'close' — the
    // same discipline the re-handshake path already follows.
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)
    await loadAndHandshake(mgr)
    const oldPort1 = channels[0]!.port1
    expect(oldPort1.close).not.toHaveBeenCalled()

    void mgr.hostToolbar.loadURL('https://host.example/next')

    expect(oldPort1.close).toHaveBeenCalled()
  })

  it('recovery: send() stays false through the navigation window and flips true ONLY after the new handshake, on the NEW port', async () => {
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)
    const view = await loadAndHandshake(mgr)
    const oldPort1 = channels[0]!.port1

    void mgr.hostToolbar.loadURL('https://host.example/next')
    expect(mgr.hostToolbar.send('during', 1)).toBe(false)

    fireWcEvent(view, 'did-finish-load') // new document's handshake

    expect(channels.length).toBe(2)
    expect(mgr.hostToolbar.send('after', 2)).toBe(true)
    expect(channels[1]!.port1.postMessage).toHaveBeenCalledExactlyOnceWith({
      channel: 'after',
      payload: 2,
    })
    expect(oldPort1.postMessage).not.toHaveBeenCalled()
  })
})

describe("Bug 1b — PAGE-INITIATED navigation ('did-start-navigation')", () => {
  it('a main-frame cross-document did-start-navigation invalidates: send() returns false, nothing posted to the old port', async () => {
    // BUG CAUGHT: page runs location.href = …; between did-start-navigation
    // and did-finish-load the old port still "works" today, so host sends are
    // confirmed true into a document being torn down.
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)
    const view = await loadAndHandshake(mgr)
    const oldPort1 = channels[0]!.port1

    fireDidStartNavigation(view, { url: 'https://elsewhere.example/' })

    expect(mgr.hostToolbar.send('chan', 'lost')).toBe(false)
    expect(oldPort1.postMessage).not.toHaveBeenCalled()
  })

  it('recovery: the navigated-to document re-handshakes on did-finish-load and send() is true on the fresh port', async () => {
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)
    const view = await loadAndHandshake(mgr)

    fireDidStartNavigation(view, { url: 'https://elsewhere.example/' })
    expect(mgr.hostToolbar.send('during', 1)).toBe(false)

    fireWcEvent(view, 'did-finish-load')

    expect(channels.length).toBe(2)
    expect(mgr.hostToolbar.send('after', 2)).toBe(true)
    expect(channels[1]!.port1.postMessage).toHaveBeenCalledExactlyOnceWith({
      channel: 'after',
      payload: 2,
    })
  })

  it('IN-PLACE navigation (isSameDocument: anchor/pushState/history) does NOT invalidate — the document survives', async () => {
    // NEGATIVE test — GREEN under the current implementation (which ignores
    // did-start-navigation entirely). It pins that the FIX must not
    // over-invalidate: an anchor click would otherwise mute the toolbar
    // channel forever (no did-finish-load follows a same-document nav, so no
    // re-handshake would ever restore it).
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)
    const view = await loadAndHandshake(mgr)

    fireDidStartNavigation(view, {
      url: 'https://host.example/toolbar#section',
      isSameDocument: true,
    })

    expect(mgr.hostToolbar.send('chan', 'still-here')).toBe(true)
    expect(channels[0]!.port1.postMessage).toHaveBeenCalledExactlyOnceWith({
      channel: 'chan',
      payload: 'still-here',
    })
  })

  it('SUBFRAME navigation (isMainFrame: false) does NOT invalidate — the main document (and its port) survives', async () => {
    // NEGATIVE test — GREEN today for the same reason as above; pins the fix
    // against muting the channel whenever an <iframe> inside the toolbar page
    // navigates (no main-frame did-finish-load follows, so it would never
    // recover).
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)
    const view = await loadAndHandshake(mgr)

    fireDidStartNavigation(view, {
      url: 'https://ad.example/frame',
      isMainFrame: false,
    })

    expect(mgr.hostToolbar.send('chan', 1)).toBe(true)
    expect(channels[0]!.port1.postMessage).toHaveBeenCalledTimes(1)
  })

  it("a STALE wc's late did-start-navigation must not drop the successor's port (activeWc discipline)", async () => {
    // GREEN today (vacuously — no listener exists). Pins the fix: the new
    // did-start-navigation handler needs the same activeWc guard as the
    // existing 'destroyed' handler, or a replaced view's death throes mute
    // the rebuilt toolbar's channel.
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)
    const firstView = await loadAndHandshake(mgr)

    // Host destroys the toolbar wc out from under us (documented rebuild path).
    firstView.webContents.close()
    fireWcEvent(firstView, 'destroyed')

    // Rebuild + fresh load + handshake on the successor.
    await mgr.hostToolbar.loadURL('https://host.example/toolbar-v2')
    const secondView = constructed[constructed.length - 1]!
    expect(secondView).not.toBe(firstView)
    fireWcEvent(secondView, 'did-finish-load')
    const freshPort1 = channels[channels.length - 1]!.port1
    expect(mgr.hostToolbar.send('sanity', 0)).toBe(true)

    // The dead wc emits a late did-start-navigation.
    fireDidStartNavigation(firstView, { url: 'https://stale.example/' })

    expect(mgr.hostToolbar.send('chan', 'alive')).toBe(true)
    expect(freshPort1.postMessage).toHaveBeenCalledTimes(2)
  })
})
