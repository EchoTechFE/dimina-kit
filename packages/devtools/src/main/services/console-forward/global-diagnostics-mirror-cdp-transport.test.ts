/**
 * Behavior tests for `createGlobalDiagnosticsMirror`'s CDP transport — same
 * fix, same reason, as `global-console-mirror-cdp-transport.test.ts`: with an
 * external CDP client and `setDevToolsWebContents` BOTH attached to
 * `mainWindow.webContents`, `target.executeJavaScript` never settles, so the
 * diagnostics mirror's `inject()` never confirms success and the standalone
 * window's diagnostics panel stays permanently empty.
 *
 * The fix routes injection through the shared `CdpSessionBroker` /
 * `CdpSessionLease` primitive (`../cdp-session/index.ts`) instead of
 * `target.executeJavaScript`: `broker.acquire(target)` gets a lease, and the
 * mirror script is sent via `lease.send('Runtime.evaluate', { expression, … })`,
 * whose CDP response (`{ result, exceptionDetails? }` or a rejection) is what
 * `inject()` now reports success/failure from.
 *
 * `createGlobalDiagnosticsMirror` takes a new 4th parameter,
 * `opts: { broker: CdpSessionBroker }`.
 */
import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import type { Diagnostic, DiagnosticsBus } from '../diagnostics/index.js'
import type { CdpSessionBroker, CdpSessionLease } from '../cdp-session/index.js'
import { createGlobalDiagnosticsMirror } from './global-diagnostics-mirror.js'

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

function makeFakeDiagnosticsBus(): {
  bus: Pick<DiagnosticsBus, 'subscribe'>
  report: (d: Omit<Diagnostic, 'ts'>) => void
} {
  const buffer: Diagnostic[] = []
  const sinks = new Set<(d: Diagnostic) => void>()
  const subscribe = vi.fn((sink: (d: Diagnostic) => void, opts?: { replay?: boolean }) => {
    const replay = opts?.replay ?? true
    if (replay) {
      for (const entry of buffer) sink(entry)
    }
    sinks.add(sink)
    let released = false
    return { dispose: () => { if (released) return; released = true; sinks.delete(sink) } }
  })
  return {
    bus: { subscribe },
    report: (d) => {
      const entry: Diagnostic = { ...d, ts: Date.now() }
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

describe('createGlobalDiagnosticsMirror — CDP transport replaces target.executeJavaScript', () => {
  it('never calls target.executeJavaScript; injects via broker.acquire(target).send("Runtime.evaluate", …) instead', async () => {
    const { bus, report } = makeFakeDiagnosticsBus()
    const { onHostChanged, fire } = makeHostChangedController()
    const { wc: target, exec } = makeWc()
    const { wc: host } = makeWc()
    const send = vi.fn().mockResolvedValue({ result: {} })
    const { broker, acquireSpy } = makeFakeBroker(makeFakeLease(send))

    createGlobalDiagnosticsMirror(bus, target, onHostChanged, { broker })
    fire(host)
    report({ severity: 'info', code: 'compile-standby', message: 'm', audience: 'internal' })
    await flushMicrotasks()

    expect(exec).not.toHaveBeenCalled()
    expect(acquireSpy).toHaveBeenCalledWith(target)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]?.[0]).toBe('Runtime.evaluate')
  })

  it('the Runtime.evaluate expression carries the existing diagnostic script markers (severity→console call + "[dimina-kit] " prefix)', async () => {
    const { bus, report } = makeFakeDiagnosticsBus()
    const { onHostChanged, fire } = makeHostChangedController()
    const { wc: target } = makeWc()
    const { wc: host } = makeWc()
    const send = vi.fn().mockResolvedValue({ result: {} })
    const { broker } = makeFakeBroker(makeFakeLease(send))

    createGlobalDiagnosticsMirror(bus, target, onHostChanged, { broker })
    fire(host)
    report({ severity: 'error', code: 'page-not-found', message: 'boom', audience: 'user' })
    await flushMicrotasks()

    const params = send.mock.calls[0]?.[1] as { expression?: string }
    expect(params?.expression).toContain('console.error(')
    expect(params?.expression).toContain('[dimina-kit]')
    expect(params?.expression).toContain('boom')
  })

  it('a Runtime.evaluate response carrying exceptionDetails is treated as a failed injection: the diagnostic is not marked done and is retried on the next reopen', async () => {
    const { bus, report } = makeFakeDiagnosticsBus()
    const { onHostChanged, fire } = makeHostChangedController()
    const { wc: target } = makeWc()
    const { wc: host } = makeWc()
    const send = vi.fn().mockResolvedValue({ result: {}, exceptionDetails: { text: 'Uncaught ReferenceError' } })
    const { broker } = makeFakeBroker(makeFakeLease(send))

    createGlobalDiagnosticsMirror(bus, target, onHostChanged, { broker })
    fire(host)
    report({ severity: 'warn', code: 'app-config-unreachable', message: 'm', audience: 'internal' })
    await flushMicrotasks()
    expect(send).toHaveBeenCalledTimes(1)

    fire(null)
    fire(host)
    await flushMicrotasks()

    expect(send).toHaveBeenCalledTimes(2)
  })

  it('a rejected send("Runtime.evaluate") is treated as a failed injection (not a crash): the diagnostic is retried on the next reopen', async () => {
    const { bus, report } = makeFakeDiagnosticsBus()
    const { onHostChanged, fire } = makeHostChangedController()
    const { wc: target } = makeWc()
    const { wc: host } = makeWc()
    const send = vi.fn().mockRejectedValue(new Error('debugger detached'))
    const { broker } = makeFakeBroker(makeFakeLease(send))

    createGlobalDiagnosticsMirror(bus, target, onHostChanged, { broker })
    fire(host)
    expect(() => report({ severity: 'error', code: 'page-not-found', message: 'm', audience: 'user' })).not.toThrow()
    await flushMicrotasks()
    expect(send).toHaveBeenCalledTimes(1)

    fire(null)
    fire(host)
    await flushMicrotasks()

    expect(send).toHaveBeenCalledTimes(2)
  })

  it('broker.acquire returning null (target already destroyed) is treated as a failed injection, not a thrown error', async () => {
    const { bus, report } = makeFakeDiagnosticsBus()
    const { onHostChanged, fire } = makeHostChangedController()
    const { wc: target } = makeWc()
    const { wc: host } = makeWc()
    const { broker, acquireSpy } = makeFakeBroker(null)

    createGlobalDiagnosticsMirror(bus, target, onHostChanged, { broker })
    fire(host)
    expect(() => report({ severity: 'info', code: 'compile-standby', message: 'm', audience: 'internal' })).not.toThrow()
    await flushMicrotasks()

    expect(acquireSpy).toHaveBeenCalledWith(target)

    fire(null)
    fire(host)
    await flushMicrotasks()

    expect(acquireSpy.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('a clean Runtime.evaluate response (no exceptionDetails) confirms success: the diagnostic is marked done and is NOT re-sent on the next reopen', async () => {
    const { bus, report } = makeFakeDiagnosticsBus()
    const { onHostChanged, fire } = makeHostChangedController()
    const { wc: target } = makeWc()
    const { wc: host } = makeWc()
    const send = vi.fn().mockResolvedValue({ result: { type: 'undefined' } })
    const { broker } = makeFakeBroker(makeFakeLease(send))

    createGlobalDiagnosticsMirror(bus, target, onHostChanged, { broker })
    fire(host)
    report({ severity: 'info', code: 'compile-standby', message: 'once', audience: 'internal' })
    await flushMicrotasks()
    expect(send).toHaveBeenCalledTimes(1)

    fire(null)
    fire(host)
    await flushMicrotasks()

    expect(send).toHaveBeenCalledTimes(1)
  })
})
