/**
 * The PAGE-side bridge must validate `channel` with the SAME semantics as the
 * main side.
 *
 * The inconsistency this guards against: the main side's
 * `hostToolbar.onMessage` (host-toolbar-port-channel.ts) throws a `TypeError`
 * for an empty-string / non-string channel, while the page bridge
 * (host-toolbar-port.ts `installHostToolbarPortBridge`) checks NOTHING on
 * either `send` or `onMessage`. An empty/garbage channel is accepted, queued,
 * posted — and then either silently dropped by main's inbound waist
 * (non-string) or silently undeliverable (no main handler can legally
 * subscribe ''), so the page author's typo vanishes without a trace.
 *
 * Locked contract (this file is the spec) — `window.diminaHostToolbar`:
 *
 *  - `send(channel, …)` and `onMessage(channel, …)` THROW a `TypeError`
 *    synchronously when `channel` is not a non-empty string (same semantics
 *    as main's onMessage guard; the message names `channel`);
 *  - the throw happens in BOTH port states (before the handshake delivers a
 *    port and after) — validation is not an accident of the queue path;
 *  - a REJECTED call leaves ZERO residue:
 *      · a rejected pre-handshake `send` occupies no pending-queue slot and
 *        is never flushed to the port,
 *      · a rejected `onMessage` registers no handler (an inbound `''`
 *        envelope — which the dispatcher's `typeof === 'string'` check lets
 *        through! — must find nobody),
 *      · valid registrations made around the rejected call keep working.
 *
 * Harness: same boot pattern as host-toolbar-runtime-port.test.ts (vitest
 * mocks are per-file; module state is per-load, so resetModules + dynamic
 * import per test).
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

/** The page-facing API, with the channel slot deliberately un-typed so the
 * invalid-input pins below need no per-call-site casts. */
type HostToolbarPageApiLoose = {
  send(channel: unknown, payload: unknown): void
  onMessage(channel: unknown, handler: (payload: unknown) => void): () => void
}

/** DOM-style MessagePort stand-in (the renderer end of the transferred port). */
type StubDomPort = {
  postMessage: ReturnType<typeof vi.fn>
  start: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  addEventListener: ReturnType<typeof vi.fn>
  removeEventListener: ReturnType<typeof vi.fn>
  emitMessage: (data: unknown) => void
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
    emitMessage: (data) => {
      for (const fn of [...listeners]) fn({ data })
    },
  }
  return port
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
})

/** Fresh-load boot: import the (reset) mocks + runtime, run activation. */
async function boot() {
  const electron = await import('electron')
  const runtime = await import('./host-toolbar-runtime.js')
  runtime.activateHostToolbarRuntime({ argv: TOOLBAR_ARGV, isMainFrame: true })
  const expose = vi.mocked(electron.contextBridge.exposeInMainWorld)
  const ipcOn = vi.mocked(electron.ipcRenderer.on)

  const bridgeCall = expose.mock.calls.find((c) => c[0] === BRIDGE_KEY)
  const api = bridgeCall?.[1] as HostToolbarPageApiLoose | undefined
  if (!api) throw new Error(`bridge '${BRIDGE_KEY}' was never exposed`)

  const handshakeCall = ipcOn.mock.calls.find((c) => c[0] === HANDSHAKE_CHANNEL)
  const handshakeListener = handshakeCall?.[1] as
    | ((event: { ports: StubDomPort[] }, ...args: unknown[]) => void)
    | undefined

  const deliverPort = (port: StubDomPort) => {
    if (!handshakeListener) throw new Error('runtime never subscribed the handshake channel')
    handshakeListener({ ports: [port] })
  }

  return { api, deliverPort }
}

const INVALID_CHANNELS: ReadonlyArray<[label: string, channel: unknown]> = [
  ['empty string', ''],
  ['number', 42],
  ['null', null],
  ['undefined', undefined],
  ['object', { channel: 'x' }],
]

describe('page-side send() validates channel (parity with main onMessage semantics)', () => {
  it.each(INVALID_CHANNELS)(
    'send(%s) throws TypeError BEFORE the handshake (queue path)',
    async (_label, bad) => {
      // Without this, the garbage envelope is silently QUEUED and later
      // flushed; main's inbound waist drops the non-string ones on the floor —
      // the page author's typo produces no signal anywhere.
      const { api } = await boot()

      expect(() => api.send(bad, 'payload')).toThrow(TypeError)
      expect(() => api.send(bad, 'payload')).toThrow(/channel/)
    },
  )

  it.each(INVALID_CHANNELS)(
    'send(%s) throws TypeError AFTER the handshake and posts nothing',
    async (_label, bad) => {
      const { api, deliverPort } = await boot()
      const port = makeDomPort()
      deliverPort(port)

      expect(() => api.send(bad, 'payload')).toThrow(TypeError)
      expect(port.postMessage).not.toHaveBeenCalled()
    },
  )

  it('a rejected pre-handshake send leaves NO queue residue — valid neighbors still flush in order', async () => {
    // Validation bolted on AFTER the enqueue (or one that swallows instead of
    // throwing) would either flush the poison envelope anyway or burn a
    // bounded-queue slot on it.
    const { api, deliverPort } = await boot()
    const port = makeDomPort()

    api.send('first', 1)
    expect(() => api.send('', 'poison')).toThrow(TypeError)
    api.send('second', 2)

    deliverPort(port)

    expect(port.postMessage.mock.calls.map((c) => c[0])).toEqual([
      { channel: 'first', payload: 1 },
      { channel: 'second', payload: 2 },
    ])
  })
})

describe('page-side onMessage() validates channel (parity with main onMessage semantics)', () => {
  it.each(INVALID_CHANNELS)('onMessage(%s) throws TypeError', async (_label, bad) => {
    const { api } = await boot()

    expect(() => api.onMessage(bad, () => {})).toThrow(TypeError)
    expect(() => api.onMessage(bad, () => {})).toThrow(/channel/)
  })

  it("a rejected onMessage('') registers NOTHING — an inbound '' envelope finds nobody", async () => {
    // The inbound dispatcher's guard is `typeof channel === 'string'`, which
    // LETS '' THROUGH — so a leaked '' registration is reachable, not dead
    // code. Validation must keep the registry clean, not just throw after the
    // push.
    const { api, deliverPort } = await boot()
    const handler = vi.fn()
    expect(() => api.onMessage('', handler)).toThrow(TypeError)

    const port = makeDomPort()
    deliverPort(port)
    port.emitMessage({ channel: '', payload: 'ghost' })

    expect(handler).not.toHaveBeenCalled()
  })

  it('valid registrations around a rejected one keep working (registry not corrupted)', async () => {
    const { api, deliverPort } = await boot()
    const a = vi.fn()
    const b = vi.fn()
    api.onMessage('a', a)
    expect(() => api.onMessage(7, vi.fn())).toThrow(TypeError)
    api.onMessage('b', b)

    const port = makeDomPort()
    deliverPort(port)
    port.emitMessage({ channel: 'a', payload: 1 })
    port.emitMessage({ channel: 'b', payload: 2 })

    expect(a).toHaveBeenCalledExactlyOnceWith(1)
    expect(b).toHaveBeenCalledExactlyOnceWith(2)
  })
})
