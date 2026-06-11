/**
 * Wave 3 R2 — host-toolbar PRELOAD side of the gated narrow channel
 * (MessagePort edition). TDD-RED: `activateHostToolbarRuntime` currently only
 * installs the height advertiser; every positive test here fails until R2
 * extends it.
 *
 * Contract under test (codex three-round review; spike evidence
 * .repro/wave3-spike/RESULTS.md items 7/8/9 + the pending-queue footgun):
 *
 *  - On a PASSING guard, activation additionally:
 *      (a) exposes the page API via
 *          `contextBridge.exposeInMainWorld('diminaHostToolbar', api)` where
 *          `api` is EXACTLY `{ send(channel, payload): void,
 *          onMessage(channel, handler): () => void }` — functions only, the
 *          MessagePort itself must NEVER cross into the main world;
 *      (b) subscribes `ipcRenderer.on('view:host-toolbar:port', …)` to receive
 *          the transferred port (`event.ports[0]`).
 *  - PENDING QUEUE (spike: the page script runs BEFORE the handshake): page
 *    `send()`s issued before the port arrives must not throw and must flush
 *    IN ORDER once it does — otherwise the page's first message is dropped.
 *  - Envelope on the wire: `{ channel, payload }` both directions.
 *  - Inbound dispatch: `{ data: { channel, payload } }` → matching page
 *    handlers; malformed data is dropped without throwing; the unsubscribe
 *    function detaches.
 *  - Same-load duplicate handshake: the LATER port wins.
 *  - FAILING guard: zero footprint extends to R2 — no bridge key, no
 *    handshake listener (R1's zero-exposure posture, new surface).
 *
 * SEAMS PINNED (implementer must follow): bridge key `'diminaHostToolbar'`,
 * handshake channel `'view:host-toolbar:port'` (= the main-side literal in
 * host-toolbar-port-channel.test.ts; export as `ViewChannel.HostToolbarPort`).
 *
 * Module state is per-load in production (preload re-runs on reload), so each
 * test gets a fresh module registry via `vi.resetModules()` + dynamic import.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  ipcRenderer: { send: vi.fn(), on: vi.fn() },
  contextBridge: { exposeInMainWorld: vi.fn() },
}))

vi.mock('./host-toolbar-advertiser.js', () => ({
  installHostToolbarAdvertiser: vi.fn(() => () => {}),
  installHostToolbarAdvertiserWhenReady: vi.fn(),
}))

const BRIDGE_KEY = 'diminaHostToolbar'
const HANDSHAKE_CHANNEL = 'view:host-toolbar:port'
const MARKER = '--dimina-host-toolbar'

const TOOLBAR_ARGV = [
  '/Applications/Electron.app/Contents/MacOS/Electron Helper (Renderer)',
  '--type=renderer',
  '--app-path=/stub/app',
  MARKER,
  '--renderer-client-id=7',
]
const NO_MARKER_ARGV = TOOLBAR_ARGV.filter((a) => a !== MARKER)

/** The page-facing API the bridge must expose. */
type HostToolbarPageApi = {
  send(channel: string, payload: unknown): void
  onMessage(channel: string, handler: (payload: unknown) => void): () => void
}

/** DOM-style MessagePort stand-in (the renderer end of the transferred port). */
type StubDomPort = {
  postMessage: ReturnType<typeof vi.fn>
  start: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  addEventListener: ReturnType<typeof vi.fn>
  removeEventListener: ReturnType<typeof vi.fn>
  onmessage: ((ev: { data: unknown }) => void) | null
  /** Test-only: deliver an inbound message through whichever hook was used. */
  emitMessage: (data: unknown) => void
  /** Test-only: was inbound delivery actually wired live (onmessage OR addEventListener+start)? */
  inboundWiredLive: () => boolean
}

function makeDomPort(): StubDomPort {
  const listeners: Array<(ev: { data: unknown }) => void> = []
  const port: StubDomPort = {
    postMessage: vi.fn(),
    start: vi.fn(),
    close: vi.fn(),
    addEventListener: vi.fn((type: string, fn: (ev: { data: unknown }) => void) => {
      if (type === 'message') listeners.push(fn)
    }),
    removeEventListener: vi.fn((type: string, fn: (ev: { data: unknown }) => void) => {
      const i = listeners.indexOf(fn)
      if (type === 'message' && i >= 0) listeners.splice(i, 1)
    }),
    onmessage: null,
    emitMessage: (data) => {
      port.onmessage?.({ data })
      for (const fn of [...listeners]) fn({ data })
    },
    // DOM semantics: assigning .onmessage implicitly start()s the port, but
    // addEventListener('message') WITHOUT start() never delivers — an
    // implementation on that path must call start() or inbound is dead.
    inboundWiredLive: () =>
      port.onmessage !== null || (listeners.length > 0 && port.start.mock.calls.length > 0),
  }
  return port
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
})

/** Fresh-load boot: import the (reset) mocks + runtime, run activation. */
async function boot(env: { argv: readonly string[]; isMainFrame: boolean } = { argv: TOOLBAR_ARGV, isMainFrame: true }) {
  const electron = await import('electron')
  const runtime = await import('./host-toolbar-runtime.js')
  const activated = runtime.activateHostToolbarRuntime(env)
  const expose = vi.mocked(electron.contextBridge.exposeInMainWorld)
  const ipcOn = vi.mocked(electron.ipcRenderer.on)

  const bridgeCall = expose.mock.calls.find((c) => c[0] === BRIDGE_KEY)
  const api = (bridgeCall?.[1] ?? null) as HostToolbarPageApi | null

  const handshakeCall = ipcOn.mock.calls.find((c) => c[0] === HANDSHAKE_CHANNEL)
  const handshakeListener = (handshakeCall?.[1] ?? null) as
    | ((event: { ports: StubDomPort[] }, ...args: unknown[]) => void)
    | null

  /** Simulate main's wc.postMessage(HANDSHAKE_CHANNEL, null, [port2]) arriving. */
  const deliverPort = (port: StubDomPort) => {
    if (!handshakeListener) throw new Error('runtime never subscribed the handshake channel')
    handshakeListener({ ports: [port] })
  }

  return { electron, activated, expose, ipcOn, api, handshakeListener, deliverPort }
}

describe('R2 preload: bridge exposure (guard passes)', () => {
  it(`exposes '${BRIDGE_KEY}' with EXACTLY { send, onMessage } — functions only, no port object`, async () => {
    // BUG CAUGHT: leaking the raw MessagePort (or any non-function) into the
    // main world hands arbitrary toolbar content a raw pipe to main, bypassing
    // the envelope/validation narrow waist this whole feature is.
    const { activated, api } = await boot()

    expect(activated).toBe(true)
    expect(api, `contextBridge.exposeInMainWorld('${BRIDGE_KEY}', …) was never called`).not.toBeNull()
    expect(Object.keys(api as object).sort()).toEqual(['onMessage', 'send'])
    expect(typeof api!.send).toBe('function')
    expect(typeof api!.onMessage).toBe('function')
  })

  it('subscribes the handshake channel and still installs the R1 height advertiser', async () => {
    // Regression guard: extending activation must not displace the advertiser
    // (the R1 incident would silently come back as height 0).
    const { handshakeListener } = await boot()
    const advertiser = await import('./host-toolbar-advertiser.js')

    expect(handshakeListener).not.toBeNull()
    expect(vi.mocked(advertiser.installHostToolbarAdvertiserWhenReady)).toHaveBeenCalledTimes(1)
  })
})

describe('R2 preload: zero footprint when the guard fails', () => {
  it('no marker: neither the bridge key nor the handshake listener appears', async () => {
    // The R1 zero-exposure posture extended to the new surface. BUG CAUGHT:
    // exposing the bridge in EVERY defaultSession renderer (main window,
    // settings, popover) hands all of them a toolbar-channel API.
    const { activated, expose, ipcOn } = await boot({ argv: NO_MARKER_ARGV, isMainFrame: true })

    expect(activated).toBe(false)
    expect(expose).not.toHaveBeenCalled()
    expect(ipcOn).not.toHaveBeenCalled()
  })

  it('subframe (marker present, isMainFrame=false): same zero footprint', async () => {
    const { activated, expose, ipcOn } = await boot({ argv: TOOLBAR_ARGV, isMainFrame: false })

    expect(activated).toBe(false)
    expect(expose).not.toHaveBeenCalled()
    expect(ipcOn).not.toHaveBeenCalled()
  })
})

describe('R2 preload: outbound send + the pending queue', () => {
  it('sends issued BEFORE the port arrives do not throw and flush IN ORDER after the handshake', async () => {
    // THE spike footgun (RESULTS.md R2 工程提示): the page script runs before
    // the handshake completes; without a pending queue the first message of
    // every load is silently dropped.
    const { api, deliverPort } = await boot()
    const port = makeDomPort()

    expect(() => {
      api!.send('a', 1)
      api!.send('b', 2)
    }).not.toThrow()
    expect(port.postMessage).not.toHaveBeenCalled()

    deliverPort(port)

    expect(port.postMessage.mock.calls.map((c) => c[0])).toEqual([
      { channel: 'a', payload: 1 },
      { channel: 'b', payload: 2 },
    ])
  })

  it('post-handshake sends go straight out as {channel, payload} envelopes', async () => {
    const { api, deliverPort } = await boot()
    const port = makeDomPort()
    deliverPort(port)

    api!.send('page:evt', { x: 'y' })

    expect(port.postMessage).toHaveBeenCalledExactlyOnceWith({
      channel: 'page:evt',
      payload: { x: 'y' },
    })
  })

  it('same-load duplicate handshake: the LATER port wins for subsequent sends', async () => {
    // BUG CAUGHT: holding the first port forever — main re-handshakes (e.g.
    // a did-finish-load it considers fresh) and closes the old port1; a
    // preload still sending on the old renderer end goes into the void.
    const { api, deliverPort } = await boot()
    const portA = makeDomPort()
    const portB = makeDomPort()
    deliverPort(portA)
    deliverPort(portB)

    api!.send('chan', 'late')

    expect(portB.postMessage).toHaveBeenCalledExactlyOnceWith({ channel: 'chan', payload: 'late' })
    expect(portA.postMessage).not.toHaveBeenCalled()
  })
})

describe('R2 preload: inbound dispatch to page handlers', () => {
  it('a handler registered BEFORE the handshake receives a post-handshake host message (and delivery is wired live)', async () => {
    // Same-ordering reality as the pending queue: the page registers its
    // handlers at script-run time, before the port exists.
    const { api, deliverPort } = await boot()
    const got: unknown[] = []
    api!.onMessage('host:cmd', (payload) => { got.push(payload) })
    const port = makeDomPort()

    deliverPort(port)
    // addEventListener('message') without start() never delivers in real DOM.
    expect(port.inboundWiredLive()).toBe(true)
    port.emitMessage({ channel: 'host:cmd', payload: 'do-it' })

    expect(got).toEqual(['do-it'])
  })

  it('routes by channel and supports unsubscribe', async () => {
    const { api, deliverPort } = await boot()
    const a = vi.fn()
    const b = vi.fn()
    const offA = api!.onMessage('a', a)
    api!.onMessage('b', b)
    const port = makeDomPort()
    deliverPort(port)

    port.emitMessage({ channel: 'a', payload: 1 })
    offA()
    port.emitMessage({ channel: 'a', payload: 2 })
    port.emitMessage({ channel: 'b', payload: 3 })

    expect(a).toHaveBeenCalledExactlyOnceWith(1)
    expect(b).toHaveBeenCalledExactlyOnceWith(3)
  })

  it('malformed inbound data is dropped without throwing', async () => {
    // Defensive symmetry with the main side: a confused/hostile counterpart
    // must not crash the preload dispatcher.
    const { api, deliverPort } = await boot()
    const handler = vi.fn()
    api!.onMessage('evt', handler)
    const port = makeDomPort()
    deliverPort(port)

    for (const data of [null, undefined, 'evt', 42, {}, { payload: 1 }, { channel: 99 }]) {
      expect(() => port.emitMessage(data)).not.toThrow()
    }
    expect(handler).not.toHaveBeenCalled()
  })

  it('handlers registered on the OLD port keep working after a same-load re-handshake', async () => {
    // Registration is module-level (like main's control-level registry), not
    // per-port: a re-handshake must re-attach dispatch to the new port.
    const { api, deliverPort } = await boot()
    const got: unknown[] = []
    api!.onMessage('evt', (payload) => { got.push(payload) })
    const portA = makeDomPort()
    const portB = makeDomPort()

    deliverPort(portA)
    portA.emitMessage({ channel: 'evt', payload: 'A' })
    deliverPort(portB)
    portB.emitMessage({ channel: 'evt', payload: 'B' })

    expect(got).toEqual(['A', 'B'])
  })
})
