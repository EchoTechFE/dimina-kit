/**
 * The preload pending queue must be BOUNDED. Without a cap,
 * `installHostToolbarPortBridge` (host-toolbar-port.ts) appends EVERY
 * pre-handshake `send()` to `pending` unconditionally; a page that never
 * finishes loading (or whose handshake never arrives) grows the array without
 * limit — memory creep driven by arbitrary host toolbar content.
 *
 * CONTRACT PINNED BY THIS FILE:
 *  - The queue holds at most HOST_TOOLBAR_PENDING_LIMIT = 128 envelopes
 *    (literal pinned here; the implementation should export the constant —
 *    e.g. from host-toolbar-port.ts or shared/constants.js — but the WIRE
 *    behavior at 128 is what these tests lock).
 *  - FIFO: queued envelopes keep arrival order; overflow drops the NEWEST
 *    send (the already-queued first-comers survive) — page boot sequences
 *    front-load their important messages, dropping the oldest would corrupt
 *    exactly those.
 *  - First overflow emits ONE console.warn; further overflowed sends stay
 *    silent (no per-message log spam from a runaway page loop).
 *  - On handshake the surviving queue flushes IN FULL and IN ORDER; dropped
 *    envelopes never surface. Post-handshake sends bypass the queue.
 *
 * Harness mirrors host-toolbar-runtime-port.test.ts (per-file vitest mocks;
 * boots through `activateHostToolbarRuntime` with the marker argv; module
 * state is per-load so each test resets modules).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

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

/** Pinned queue cap — see header. */
const HOST_TOOLBAR_PENDING_LIMIT = 128

const TOOLBAR_ARGV = [
  '/Applications/Electron.app/Contents/MacOS/Electron Helper (Renderer)',
  '--type=renderer',
  '--app-path=/stub/app',
  MARKER,
  '--renderer-client-id=7',
]

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
  }
  return port
}

let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  // Silence + count the overflow warning; restored in afterEach.
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  warnSpy.mockRestore()
})

/** Fresh-load boot: import the (reset) mocks + runtime, run activation. */
async function boot() {
  const electron = await import('electron')
  const runtime = await import('./host-toolbar-runtime.js')
  runtime.activateHostToolbarRuntime({ argv: TOOLBAR_ARGV, isMainFrame: true })
  const expose = vi.mocked(electron.contextBridge.exposeInMainWorld)
  const ipcOn = vi.mocked(electron.ipcRenderer.on)

  const bridgeCall = expose.mock.calls.find((c) => c[0] === BRIDGE_KEY)
  const api = bridgeCall?.[1] as HostToolbarPageApi | undefined
  if (!api) throw new Error(`contextBridge.exposeInMainWorld('${BRIDGE_KEY}', …) was never called`)

  const handshakeCall = ipcOn.mock.calls.find((c) => c[0] === HANDSHAKE_CHANNEL)
  const handshakeListener = handshakeCall?.[1] as
    | ((event: { ports: StubDomPort[] }, ...args: unknown[]) => void)
    | undefined
  if (!handshakeListener) throw new Error('runtime never subscribed the handshake channel')

  /** Simulate main's wc.postMessage(HANDSHAKE_CHANNEL, null, [port2]) arriving. */
  const deliverPort = (port: StubDomPort) => handshakeListener({ ports: [port] })

  return { api, deliverPort }
}

/** Queue `count` sends tagged 0..count-1 on channel 'q'. */
function sendBatch(api: HostToolbarPageApi, count: number, startAt = 0): void {
  for (let i = startAt; i < startAt + count; i++) api.send('q', i)
}

/** The payload sequence that reached the port, in postMessage order. */
function flushedPayloads(port: StubDomPort): unknown[] {
  return port.postMessage.mock.calls.map(
    (c) => (c[0] as { channel: string; payload: unknown }).payload,
  )
}

describe('pending queue cap at HOST_TOOLBAR_PENDING_LIMIT (128)', () => {
  it('exactly 128 pre-handshake sends: ALL flush in FIFO order on handshake, no warning', async () => {
    // Boundary guard: the cap must not eat messages BELOW the limit, and a
    // full-but-not-overflowing queue is not warn-worthy.
    const { api, deliverPort } = await boot()
    const port = makeDomPort()

    sendBatch(api, HOST_TOOLBAR_PENDING_LIMIT)
    expect(warnSpy).not.toHaveBeenCalled()

    deliverPort(port)

    expect(port.postMessage).toHaveBeenCalledTimes(HOST_TOOLBAR_PENDING_LIMIT)
    expect(flushedPayloads(port)).toEqual(
      Array.from({ length: HOST_TOOLBAR_PENDING_LIMIT }, (_, i) => i),
    )
  })

  it('overflow drops the NEWEST sends: only the first 128 ever reach the port', async () => {
    // An unbounded queue would buffer and flush all 131 envelopes; a page that
    // never finishes loading grows this array forever. The cap keeps the
    // first-comers (boot-sequence messages) and drops the overflow.
    const { api, deliverPort } = await boot()
    const port = makeDomPort()

    sendBatch(api, HOST_TOOLBAR_PENDING_LIMIT + 3)

    deliverPort(port)

    expect(port.postMessage).toHaveBeenCalledTimes(HOST_TOOLBAR_PENDING_LIMIT)
    const payloads = flushedPayloads(port)
    expect(payloads).toEqual(Array.from({ length: HOST_TOOLBAR_PENDING_LIMIT }, (_, i) => i))
    // The overflowed tail (128, 129, 130) must NEVER surface — not in the
    // flush and not later.
    expect(payloads).not.toContain(HOST_TOOLBAR_PENDING_LIMIT)
    expect(payloads).not.toContain(HOST_TOOLBAR_PENDING_LIMIT + 2)
  })

  it('overflowed sends do not throw (page-facing send stays void/fire-and-forget)', async () => {
    // The toolbar page is arbitrary host content; a full queue must degrade
    // to a silent drop + warn, never an exception into page code.
    const { api } = await boot()

    sendBatch(api, HOST_TOOLBAR_PENDING_LIMIT)
    expect(() => api.send('q', 'overflowing')).not.toThrow()
  })

  it('warns EXACTLY ONCE on first overflow, at overflow time, and never again for later drops', async () => {
    // Without a warning, host developers would see messages vanish with zero
    // signal. A per-drop warning would let a runaway page send-loop spam the
    // console; the contract is one warning per load.
    const { api, deliverPort } = await boot()

    sendBatch(api, HOST_TOOLBAR_PENDING_LIMIT)
    expect(warnSpy).not.toHaveBeenCalled()

    api.send('q', HOST_TOOLBAR_PENDING_LIMIT) // first drop
    expect(warnSpy).toHaveBeenCalledTimes(1) // warned at overflow time, pre-handshake

    api.send('q', HOST_TOOLBAR_PENDING_LIMIT + 1)
    api.send('q', HOST_TOOLBAR_PENDING_LIMIT + 2)
    expect(warnSpy).toHaveBeenCalledTimes(1)

    // Flushing the queue is not an overflow either.
    deliverPort(makeDomPort())
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('overflow does not poison the channel: after the handshake, new sends bypass the queue and go straight out', async () => {
    // An implementation that flushes the unbounded backlog would post 131
    // envelopes here, not 128 + 1.
    const { api, deliverPort } = await boot()
    const port = makeDomPort()

    sendBatch(api, HOST_TOOLBAR_PENDING_LIMIT + 3)
    deliverPort(port)

    api.send('live', 'direct')

    expect(port.postMessage).toHaveBeenCalledTimes(HOST_TOOLBAR_PENDING_LIMIT + 1)
    expect(port.postMessage).toHaveBeenLastCalledWith({ channel: 'live', payload: 'direct' })
  })
})
