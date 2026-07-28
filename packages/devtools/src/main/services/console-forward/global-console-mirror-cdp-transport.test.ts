/**
 * Behavior tests for `createGlobalConsoleMirror`'s CDP transport — the fix
 * for a production incident where the standalone "debug the whole Electron
 * app" window is attached to `mainWindow.webContents` via BOTH an external
 * CDP client's `Target.attachToTarget` AND `setDevToolsWebContents`: with two
 * simultaneous debugger attachments, `mainWindow.webContents.executeJavaScript`
 * never settles, so the console mirror's `inject()` never confirms success or
 * failure and the standalone window's Console panel stays permanently empty.
 *
 * The fix routes injection through the same `CdpSessionBroker` /
 * `CdpSessionLease` primitive the render-inspection modules already share
 * (`../cdp-session/index.ts`) instead of `target.executeJavaScript`:
 * `broker.acquire(target)` gets a lease, and the mirror script is sent via
 * `lease.send('Runtime.evaluate', { expression, ... })`, whose CDP response
 * (`{ result, exceptionDetails? }` or a rejection) is what `inject()` now
 * reports success/failure from — a channel that stays responsive even while
 * an external CDP client shares the same wc.
 *
 * `createGlobalConsoleMirror` takes a new 4th parameter,
 * `opts: { broker: CdpSessionBroker }`.
 */
import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import type { ConsoleForwarder, ConsoleSink, GuestConsoleEntry } from './index.js'
import type { CdpSessionBroker, CdpSessionLease } from '../cdp-session/index.js'
import { createGlobalConsoleMirror } from './global-console-mirror.js'

async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

function makeWc(opts: { destroyed?: boolean, loading?: boolean, url?: string } = {}): { wc: WebContents, exec: ReturnType<typeof vi.fn> } {
  const exec = vi.fn(() => Promise.resolve(undefined))
  const wc = {
    isDestroyed: () => opts.destroyed ?? false,
    getURL: () => opts.url ?? 'file:///main-window.html',
    isLoadingMainFrame: () => opts.loading ?? false,
    executeJavaScript: exec,
  } as unknown as WebContents
  return { wc, exec }
}

function makeFakeForwarder(): {
  forwarder: Pick<ConsoleForwarder, 'subscribe'>
  emit: (entry: GuestConsoleEntry) => void
} {
  const buffer: GuestConsoleEntry[] = []
  const sinks = new Set<ConsoleSink>()
  const subscribe = vi.fn((sink: ConsoleSink, opts?: { replay?: boolean }) => {
    const replay = opts?.replay ?? false
    if (replay) {
      for (const entry of buffer) sink(entry)
    }
    sinks.add(sink)
    let released = false
    return { dispose: () => { if (released) return; released = true; sinks.delete(sink) } }
  })
  return {
    forwarder: { subscribe },
    emit: (entry) => {
      buffer.push(entry)
      for (const sink of [...sinks]) sink(entry)
    },
  }
}

function makeHostChangedController(): {
  onHostChanged: (handler: (hostWc: WebContents | null) => void) => () => void
  fire: (hostWc: WebContents | null) => void
} {
  let handler: ((hostWc: WebContents | null) => void) | null = null
  const unregisterSpy = vi.fn()
  const registerSpy = vi.fn((h: (hostWc: WebContents | null) => void) => {
    handler = h
    return unregisterSpy
  })
  return {
    onHostChanged: registerSpy,
    fire: (hostWc) => {
      if (!handler) throw new Error('onHostChanged handler was never registered')
      handler(hostWc)
    },
  }
}

/** Minimal fake `CdpSessionLease` — only `send` matters to this mirror. */
function makeFakeLease(send: ReturnType<typeof vi.fn>): CdpSessionLease {
  return {
    send,
    onMessage: vi.fn(() => ({ dispose: vi.fn() })),
    onDetach: vi.fn(() => ({ dispose: vi.fn() })),
    ensureRenderDomains: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
  } as unknown as CdpSessionLease
}

/** Fake `CdpSessionBroker` — `acquire` returns a fixed lease (or null). */
function makeFakeBroker(lease: CdpSessionLease | null): { broker: CdpSessionBroker, acquireSpy: ReturnType<typeof vi.fn> } {
  const acquireSpy = vi.fn(() => lease)
  return { broker: { acquire: acquireSpy, dispose: vi.fn() }, acquireSpy }
}

describe('createGlobalConsoleMirror — CDP transport replaces target.executeJavaScript', () => {
  it('never calls target.executeJavaScript; injects via broker.acquire(target).send("Runtime.evaluate", …) instead', async () => {
    const { forwarder, emit } = makeFakeForwarder()
    const { onHostChanged, fire } = makeHostChangedController()
    const { wc: target, exec } = makeWc()
    const { wc: host } = makeWc()
    const send = vi.fn().mockResolvedValue({ result: {} })
    const lease = makeFakeLease(send)
    const { broker, acquireSpy } = makeFakeBroker(lease)

    createGlobalConsoleMirror(forwarder, target, onHostChanged, { broker })
    fire(host)
    emit({ source: 'service', level: 'log', args: ['hi'] })
    await flushMicrotasks()

    expect(exec).not.toHaveBeenCalled()
    expect(acquireSpy).toHaveBeenCalledWith(target)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]?.[0]).toBe('Runtime.evaluate')
  })

  it('the Runtime.evaluate expression carries the existing mirror script markers (source tag + console[method] call)', async () => {
    const { forwarder, emit } = makeFakeForwarder()
    const { onHostChanged, fire } = makeHostChangedController()
    const { wc: target } = makeWc()
    const { wc: host } = makeWc()
    const send = vi.fn().mockResolvedValue({ result: {} })
    const { broker } = makeFakeBroker(makeFakeLease(send))

    createGlobalConsoleMirror(forwarder, target, onHostChanged, { broker })
    fire(host)
    emit({ source: 'render', level: 'warn', args: ['boo'] })
    await flushMicrotasks()

    const params = send.mock.calls[0]?.[1] as { expression?: string }
    expect(params?.expression).toContain('[render]')
    expect(params?.expression).toContain('console["warn"]')
  })

  it('a Runtime.evaluate response carrying exceptionDetails is treated as a failed injection: the entry is not marked done and is retried on the next reopen', async () => {
    const { forwarder, emit } = makeFakeForwarder()
    const { onHostChanged, fire } = makeHostChangedController()
    const { wc: target } = makeWc()
    const { wc: host } = makeWc()
    const send = vi.fn().mockResolvedValue({ result: {}, exceptionDetails: { text: 'Uncaught ReferenceError' } })
    const { broker } = makeFakeBroker(makeFakeLease(send))

    createGlobalConsoleMirror(forwarder, target, onHostChanged, { broker })
    fire(host)
    emit({ source: 'service', level: 'error', args: ['boom'] })
    await flushMicrotasks()
    expect(send).toHaveBeenCalledTimes(1)

    fire(null)
    fire(host)
    await flushMicrotasks()

    expect(send).toHaveBeenCalledTimes(2)
  })

  it('a rejected send("Runtime.evaluate") is treated as a failed injection (not a crash): the entry is retried on the next reopen', async () => {
    const { forwarder, emit } = makeFakeForwarder()
    const { onHostChanged, fire } = makeHostChangedController()
    const { wc: target } = makeWc()
    const { wc: host } = makeWc()
    const send = vi.fn().mockRejectedValue(new Error('debugger detached'))
    const { broker } = makeFakeBroker(makeFakeLease(send))

    createGlobalConsoleMirror(forwarder, target, onHostChanged, { broker })
    fire(host)
    expect(() => emit({ source: 'service', level: 'error', args: ['boom'] })).not.toThrow()
    await flushMicrotasks()
    expect(send).toHaveBeenCalledTimes(1)

    fire(null)
    fire(host)
    await flushMicrotasks()

    expect(send).toHaveBeenCalledTimes(2)
  })

  it('broker.acquire returning null (target already destroyed) is treated as a failed injection, not a thrown error', async () => {
    const { forwarder, emit } = makeFakeForwarder()
    const { onHostChanged, fire } = makeHostChangedController()
    const { wc: target } = makeWc()
    const { wc: host } = makeWc()
    const { broker, acquireSpy } = makeFakeBroker(null)

    createGlobalConsoleMirror(forwarder, target, onHostChanged, { broker })
    fire(host)
    expect(() => emit({ source: 'service', level: 'log', args: ['x'] })).not.toThrow()
    await flushMicrotasks()

    expect(acquireSpy).toHaveBeenCalledWith(target)

    fire(null)
    fire(host)
    await flushMicrotasks()

    // Retried on the next reopen since acquire() failing must not have
    // permanently marked the entry done.
    expect(acquireSpy.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('a clean Runtime.evaluate response (no exceptionDetails) confirms success: the entry is marked done and is NOT re-sent on the next reopen', async () => {
    const { forwarder, emit } = makeFakeForwarder()
    const { onHostChanged, fire } = makeHostChangedController()
    const { wc: target } = makeWc()
    const { wc: host } = makeWc()
    const send = vi.fn().mockResolvedValue({ result: { type: 'undefined' } })
    const { broker } = makeFakeBroker(makeFakeLease(send))

    createGlobalConsoleMirror(forwarder, target, onHostChanged, { broker })
    fire(host)
    emit({ source: 'service', level: 'log', args: ['once'] })
    await flushMicrotasks()
    expect(send).toHaveBeenCalledTimes(1)

    fire(null)
    fire(host)
    await flushMicrotasks()

    expect(send).toHaveBeenCalledTimes(1)
  })
})
