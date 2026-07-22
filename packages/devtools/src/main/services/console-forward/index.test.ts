/**
 * Behavior tests for createConsoleForwarder.
 *
 * The forwarder owns `ctx.guestConsole` and fans every guest console entry out
 * to two consumers:
 *   1. external subscribers (automation WS) — see EVERY entry, both layers;
 *   2. a built-in render→service mirror — re-emits ONLY render-layer entries
 *      into the matching app's service-host console, `[视图]`-prefixed.
 *
 * The mirror's loop-safety hinges on skipping `source:'service'` entries, so
 * these tests assert exactly which entries reach the service host. No electron
 * is needed — the forwarder talks to a small `bridge` shape and to fake
 * WebContents exposing `isDestroyed` + `executeJavaScript`.
 */
import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { createConsoleForwarder, type GuestConsoleEntry } from './index.js'

function makeWc(): { wc: WebContents; exec: ReturnType<typeof vi.fn> } {
  const exec = vi.fn(() => Promise.resolve(undefined))
  const wc = {
    isDestroyed: () => false,
    executeJavaScript: exec,
  } as unknown as WebContents
  return { wc, exec }
}

function render(args: unknown[], extra: Partial<GuestConsoleEntry> = {}): GuestConsoleEntry {
  return { source: 'render', level: 'log', args, ...extra }
}

describe('createConsoleForwarder', () => {
  it('mirrors a render-layer entry into the service host with a [视图] prefix at the original level', () => {
    const { wc, exec } = makeWc()
    const fwd = createConsoleForwarder({
      getServiceWc: () => wc,
      getServiceWcForBridge: () => null,
    })

    fwd.emit(render(['hello', 42], { level: 'warn' }))

    expect(exec).toHaveBeenCalledTimes(1)
    const script = String(exec.mock.calls[0]![0])
    // The forwarded line preserves the original console method (severity filter)
    expect(script).toContain('console["warn"]')
    expect(script).toContain('[视图]')
    // Args are carried as JSON data and re-parsed, never interpolated as code.
    expect(script).toContain(JSON.stringify(JSON.stringify(['hello', 42])))
  })

  it('does NOT forward a service-layer entry (already native; would loop)', () => {
    const { wc, exec } = makeWc()
    const fwd = createConsoleForwarder({
      getServiceWc: () => wc,
      getServiceWcForBridge: () => null,
    })

    fwd.emit({ source: 'service', level: 'log', args: ['from service'] })
    // The re-captured `[视图]` line the service host emits comes back as
    // source:'service' too — proving the loop terminates here.
    fwd.emit({ source: 'service', level: 'log', args: ['[视图]', 'echo'] })

    expect(exec).not.toHaveBeenCalled()
  })

  it('fans every entry (render AND service) out to subscribers', () => {
    const { wc } = makeWc()
    const fwd = createConsoleForwarder({
      getServiceWc: () => wc,
      getServiceWcForBridge: () => null,
    })
    const sink = vi.fn()
    fwd.subscribe(sink)

    fwd.emit(render(['r']))
    fwd.emit({ source: 'service', level: 'error', args: ['s'] })

    expect(sink).toHaveBeenCalledTimes(2)
    expect((sink.mock.calls[0]![0] as GuestConsoleEntry).source).toBe('render')
    expect((sink.mock.calls[1]![0] as GuestConsoleEntry).source).toBe('service')
  })

  it('stops delivering to a subscriber after it disposes', () => {
    const { wc } = makeWc()
    const fwd = createConsoleForwarder({
      getServiceWc: () => wc,
      getServiceWcForBridge: () => null,
    })
    const sink = vi.fn()
    const sub = fwd.subscribe(sink)

    fwd.emit(render(['a']))
    sub.dispose()
    fwd.emit(render(['b']))

    expect(sink).toHaveBeenCalledTimes(1)
  })

  it('targets the owning app via getServiceWcForBridge (multi-app), not the active one', () => {
    const owning = makeWc()
    const active = makeWc()
    const fwd = createConsoleForwarder({
      getServiceWc: () => active.wc,
      getServiceWcForBridge: (id) => (id === 'bridge-A' ? owning.wc : null),
    })

    fwd.emit(render(['x'], { bridgeId: 'bridge-A' }))

    expect(owning.exec).toHaveBeenCalledTimes(1)
    expect(active.exec).not.toHaveBeenCalled()
  })

  it('falls back to the active service host when the bridgeId is unknown', () => {
    const active = makeWc()
    const fwd = createConsoleForwarder({
      getServiceWc: () => active.wc,
      getServiceWcForBridge: () => null,
    })

    fwd.emit(render(['x'], { bridgeId: 'gone' }))

    expect(active.exec).toHaveBeenCalledTimes(1)
  })

  it('never writes to a destroyed/missing service host', () => {
    const fwd = createConsoleForwarder({
      getServiceWc: () => null,
      getServiceWcForBridge: () => null,
    })
    // No host → no throw, no exec.
    expect(() => fwd.emit(render(['x']))).not.toThrow()
  })

  it('drops a render entry whose args are not JSON-serializable instead of throwing', () => {
    const { wc, exec } = makeWc()
    const fwd = createConsoleForwarder({
      getServiceWc: () => wc,
      getServiceWcForBridge: () => null,
    })
    const circular: Record<string, unknown> = {}
    circular.self = circular

    expect(() => fwd.emit(render([circular]))).not.toThrow()
    expect(exec).not.toHaveBeenCalled()
  })

  it('does NOT forward a render-layer entry that is dimina framework-internal log output', () => {
    const { wc, exec } = makeWc()
    const fwd = createConsoleForwarder({
      getServiceWc: () => wc,
      getServiceWcForBridge: () => null,
    })

    fwd.emit(render(['[system]', 'render lifecycle log']))
    fwd.emit(render(['[service]', 'bridge log']))
    fwd.emit(render(['[service] extra detail', 'more']))

    expect(exec).not.toHaveBeenCalled()
  })

  it('still forwards a render-layer entry that is an ordinary business console call (no false-positive internal-log skip)', () => {
    const { wc, exec } = makeWc()
    const fwd = createConsoleForwarder({
      getServiceWc: () => wc,
      getServiceWcForBridge: () => null,
    })

    fwd.emit(render(['hello', 123]))

    expect(exec).toHaveBeenCalledTimes(1)
    const script = String(exec.mock.calls[0]![0])
    expect(script).toContain('console["log"]')
    expect(script).toContain('[视图]')
    expect(script).toContain(JSON.stringify(JSON.stringify(['hello', 123])))
  })

  it('still delivers a render-layer internal-log entry to subscribers even though it is skipped for the service-host forward', () => {
    const { wc, exec } = makeWc()
    const fwd = createConsoleForwarder({
      getServiceWc: () => wc,
      getServiceWcForBridge: () => null,
    })
    const sink = vi.fn()
    fwd.subscribe(sink)

    fwd.emit(render(['[system]', 'render lifecycle log']))

    expect(sink).toHaveBeenCalledTimes(1)
    expect((sink.mock.calls[0]![0] as GuestConsoleEntry).args).toEqual(['[system]', 'render lifecycle log'])
    // The internal-log gate only affects the service-host forward, not the sink fan-out.
    expect(exec).not.toHaveBeenCalled()
  })

  it('one throwing subscriber does not break the others or the mirror', () => {
    const { wc, exec } = makeWc()
    const fwd = createConsoleForwarder({
      getServiceWc: () => wc,
      getServiceWcForBridge: () => null,
    })
    const bad = vi.fn(() => { throw new Error('boom') })
    const good = vi.fn()
    fwd.subscribe(bad)
    fwd.subscribe(good)

    expect(() => fwd.emit(render(['x']))).not.toThrow()
    expect(good).toHaveBeenCalledTimes(1)
    expect(exec).toHaveBeenCalledTimes(1)
  })
})

/**
 * `ConsoleForwarder.subscribe` replay behavior.
 *
 * The forwarder now keeps a bounded history buffer (mirroring
 * `DiagnosticsBus`'s `DEFAULT_BUFFER_CAP` ring-buffer style) so a subscriber
 * that opts into `{replay:true}` can catch up on entries emitted before it
 * subscribed — this is what `createGlobalConsoleMirror` needs to fix the
 * "standalone debug window shows an empty Console panel" bug.
 *
 * The default MUST stay non-replaying (`replay` defaults to `false`, the
 * OPPOSITE of `DiagnosticsBus`'s default): `automation/index.ts:92` already
 * calls `ctx.consoleForwarder?.subscribe((entry) => {...})` with no second
 * argument, relying on "a new subscriber only sees entries emitted after it
 * subscribes" — a history dump replayed into that existing call site would
 * rebroadcast stale `App.logAdded` events to every newly-connected
 * automation client. That existing behavior must not regress.
 */
describe('createConsoleForwarder — subscribe replay', () => {
  it('a subscriber with no options at all does NOT receive entries emitted before it subscribed (regression guard for automation/index.ts:92)', () => {
    const { wc } = makeWc()
    const fwd = createConsoleForwarder({ getServiceWc: () => wc, getServiceWcForBridge: () => null })
    fwd.emit(render(['before subscribe']))

    const sink = vi.fn()
    fwd.subscribe(sink)
    fwd.emit(render(['after subscribe']))

    expect(sink).toHaveBeenCalledTimes(1)
    expect((sink.mock.calls[0]![0] as GuestConsoleEntry).args).toEqual(['after subscribe'])
  })

  it('a subscriber with {replay:false} explicitly does not receive entries emitted before it subscribed', () => {
    const { wc } = makeWc()
    const fwd = createConsoleForwarder({ getServiceWc: () => wc, getServiceWcForBridge: () => null })
    fwd.emit(render(['before subscribe']))

    const sink = vi.fn()
    fwd.subscribe(sink, { replay: false })
    fwd.emit(render(['after subscribe']))

    expect(sink).toHaveBeenCalledTimes(1)
    expect((sink.mock.calls[0]![0] as GuestConsoleEntry).args).toEqual(['after subscribe'])
  })

  it('subscribe(sink, {replay:true}) replays every buffered entry, in order, before any newly-emitted entry reaches it', () => {
    const { wc } = makeWc()
    const fwd = createConsoleForwarder({ getServiceWc: () => wc, getServiceWcForBridge: () => null })
    fwd.emit(render(['e1']))
    fwd.emit(render(['e2']))

    const sink = vi.fn()
    fwd.subscribe(sink, { replay: true })

    expect(sink).toHaveBeenCalledTimes(2)
    expect((sink.mock.calls[0]![0] as GuestConsoleEntry).args).toEqual(['e1'])
    expect((sink.mock.calls[1]![0] as GuestConsoleEntry).args).toEqual(['e2'])

    fwd.emit(render(['e3']))
    expect(sink).toHaveBeenCalledTimes(3)
    expect((sink.mock.calls[2]![0] as GuestConsoleEntry).args).toEqual(['e3'])
  })

  it('emit() buffers entries even while there is no subscriber at all yet, so a later {replay:true} subscriber still catches up', () => {
    const { wc } = makeWc()
    const fwd = createConsoleForwarder({ getServiceWc: () => wc, getServiceWcForBridge: () => null })
    // Nothing has ever subscribed at this point.
    fwd.emit(render(['nobody was listening']))

    const sink = vi.fn()
    fwd.subscribe(sink, { replay: true })

    expect(sink).toHaveBeenCalledTimes(1)
    expect((sink.mock.calls[0]![0] as GuestConsoleEntry).args).toEqual(['nobody was listening'])
  })

  it('the history buffer is bounded at 200 entries and drops the oldest once full (mirrors DiagnosticsBus\'s DEFAULT_BUFFER_CAP ring-buffer style)', () => {
    const { wc } = makeWc()
    const fwd = createConsoleForwarder({ getServiceWc: () => wc, getServiceWcForBridge: () => null })
    for (let i = 0; i < 201; i++) {
      fwd.emit(render([i]))
    }

    const sink = vi.fn()
    fwd.subscribe(sink, { replay: true })

    expect(sink).toHaveBeenCalledTimes(200)
    // Entry 0 was evicted to make room for entry 200 — the buffer keeps the
    // most recent 200, i.e. indices 1..200.
    expect((sink.mock.calls[0]![0] as GuestConsoleEntry).args).toEqual([1])
    expect((sink.mock.calls[199]![0] as GuestConsoleEntry).args).toEqual([200])
  })

  it('each subscription\'s replay option is independent — a replaying sink sees history while a non-replaying sink registered at the same moment does not', () => {
    const { wc } = makeWc()
    const fwd = createConsoleForwarder({ getServiceWc: () => wc, getServiceWcForBridge: () => null })
    fwd.emit(render(['history']))

    const replaySink = vi.fn()
    const liveOnlySink = vi.fn()
    fwd.subscribe(replaySink, { replay: true })
    fwd.subscribe(liveOnlySink)

    expect(replaySink).toHaveBeenCalledTimes(1)
    expect(liveOnlySink).not.toHaveBeenCalled()

    fwd.emit(render(['live']))
    expect(replaySink).toHaveBeenCalledTimes(2)
    expect(liveOnlySink).toHaveBeenCalledTimes(1)
  })
})
