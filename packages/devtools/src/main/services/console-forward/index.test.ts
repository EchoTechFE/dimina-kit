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
