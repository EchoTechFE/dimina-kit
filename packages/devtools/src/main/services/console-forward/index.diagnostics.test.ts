/**
 * Behavior tests for the diagnostics-injection path added to
 * `createConsoleForwarder(bridge, diagnostics?)`.
 *
 * Today, main-process diagnostics (page-not-found, logic-bundle-unreachable, …)
 * only reach `console.error`/`console.warn` in the MAIN process log and — for
 * the render mirror only — the automation WS. They never reach the embedded
 * Chrome DevTools Console panel, because that panel is CDP-attached to the
 * service-host webContents and only shows what actually executes THERE. When a
 * `DiagnosticsBus` is supplied, the forwarder must subscribe to it and inject
 * each diagnostic into the OWNING session's service-host console — using the
 * exact same loop-safety sentinel (`RENDER_FORWARD_SOURCE_URL`) the existing
 * render→service mirror uses, so service-console's CDP capture does not
 * re-broadcast the injected line as a fresh entry.
 *
 * A diagnostic can be reported before its service host exists yet (main boots
 * fast, the window spawn is async) — those must queue and flush exactly once
 * `notifyServiceHostReady(appSessionId)` fires for that session, without
 * double-injecting on a second notify.
 *
 * No electron needed: the forwarder only depends on the narrow `bridge` shape
 * (`getServiceWc`/`getServiceWcForBridge`) and a fake WebContents exposing
 * `isDestroyed`/`executeJavaScript`, exactly like `index.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { createConsoleForwarder } from './index.js'
import { RENDER_FORWARD_SOURCE_URL } from '../service-console/console-api.js'

/** Minimal structural mirror of the not-yet-existing DiagnosticsBus/Diagnostic
 * shapes (contract 1). Defined locally so this file tests console-forward's
 * consumption of a diagnostics bus WITHOUT depending on that module's own
 * existence/tests. */
interface FakeDiagnostic {
  severity: 'error' | 'warn' | 'info'
  code: string
  message: string
  appSessionId?: string
  /** Contract 1 (not yet on the real `Diagnostic` type): `'internal'` diagnostics
   *  must never reach the user-facing service host — see the "audience" describe
   *  block below. Undefined/`'user'` behave exactly like today. */
  audience?: 'user' | 'internal'
  ts: number
}
interface FakeDiagnosticsBus {
  report(d: Omit<FakeDiagnostic, 'ts'>): void
  subscribe(sink: (d: FakeDiagnostic) => void): { dispose(): void }
}

function makeFakeDiagnosticsBus(): FakeDiagnosticsBus {
  const sinks = new Set<(d: FakeDiagnostic) => void>()
  return {
    report(d) {
      const entry: FakeDiagnostic = { ...d, ts: Date.now() }
      for (const sink of [...sinks]) sink(entry)
    },
    subscribe(sink) {
      sinks.add(sink)
      return { dispose: () => { sinks.delete(sink) } }
    },
  }
}

function makeWc(): { wc: WebContents; exec: ReturnType<typeof vi.fn>; destroy(): void } {
  let destroyed = false
  const exec = vi.fn(() => Promise.resolve(undefined))
  const wc = {
    isDestroyed: () => destroyed,
    executeJavaScript: exec,
  } as unknown as WebContents
  return { wc, exec, destroy: () => { destroyed = true } }
}

describe('createConsoleForwarder(bridge, diagnostics) — immediate injection', () => {
  it('subscribes to the supplied diagnostics bus and injects a reported diagnostic into the resolved service host', () => {
    const target = makeWc()
    const diagnostics = makeFakeDiagnosticsBus()
    createConsoleForwarder(
      { getServiceWc: () => target.wc, getServiceWcForBridge: () => null },
      diagnostics as never,
    )

    diagnostics.report({ severity: 'error', code: 'page-not-found', message: 'Page[pages/x/x] not found' })

    expect(target.exec).toHaveBeenCalledTimes(1)
  })

  it('the injected script carries the RENDER_FORWARD_SOURCE_URL sentinel (loop-safety) so CDP capture never re-broadcasts it', () => {
    const target = makeWc()
    const diagnostics = makeFakeDiagnosticsBus()
    createConsoleForwarder(
      { getServiceWc: () => target.wc, getServiceWcForBridge: () => null },
      diagnostics as never,
    )

    diagnostics.report({ severity: 'error', code: 'page-not-found', message: 'Page[pages/x/x] not found' })

    const script = String(target.exec.mock.calls[0]![0])
    expect(script).toContain(RENDER_FORWARD_SOURCE_URL)
  })

  it('the injected script carries a "[dimina-kit]" prefix and the diagnostic message', () => {
    const target = makeWc()
    const diagnostics = makeFakeDiagnosticsBus()
    createConsoleForwarder(
      { getServiceWc: () => target.wc, getServiceWcForBridge: () => null },
      diagnostics as never,
    )

    diagnostics.report({ severity: 'warn', code: 'app-config-unreachable', message: 'app-config.json fetch failed' })

    const script = String(target.exec.mock.calls[0]![0])
    expect(script).toContain('[dimina-kit]')
    expect(script).toContain('app-config.json fetch failed')
  })

  it.each([
    ['error', 'error'],
    ['warn', 'warn'],
    ['info', 'info'],
  ] as const)('maps severity:%s to console.%s in the injected script', (severity, method) => {
    const target = makeWc()
    const diagnostics = makeFakeDiagnosticsBus()
    createConsoleForwarder(
      { getServiceWc: () => target.wc, getServiceWcForBridge: () => null },
      diagnostics as never,
    )

    diagnostics.report({ severity, code: 'x', message: 'm' })

    const script = String(target.exec.mock.calls[0]![0])
    expect(script).toContain(`console.${method}`)
  })

  it('calls executeJavaScript with the "run in isolated world" flag (matches the existing render-mirror contract)', () => {
    const target = makeWc()
    const diagnostics = makeFakeDiagnosticsBus()
    createConsoleForwarder(
      { getServiceWc: () => target.wc, getServiceWcForBridge: () => null },
      diagnostics as never,
    )

    diagnostics.report({ severity: 'error', code: 'x', message: 'm' })

    expect(target.exec).toHaveBeenCalledWith(expect.any(String), true)
  })
})

describe('createConsoleForwarder(bridge, diagnostics) — session targeting', () => {
  it('after its session is ready, injects via getServiceWcForBridge(appSessionId) — never the active host', () => {
    // Direct injection for a session-owned diagnostic requires the session to
    // have been marked ready (notifyServiceHostReady): a resolvable wc alone
    // may still be pre-navigation, and anything injected there is wiped by the
    // spawn load.
    const owning = makeWc()
    const active = makeWc()
    const diagnostics = makeFakeDiagnosticsBus()
    const fwd = createConsoleForwarder(
      {
        getServiceWc: () => active.wc,
        getServiceWcForBridge: (id) => (id === 'session-A' ? owning.wc : null),
      },
      diagnostics as never,
    )

    fwd.notifyServiceHostReady('session-A')
    diagnostics.report({ severity: 'error', code: 'x', message: 'm', appSessionId: 'session-A' })

    expect(owning.exec).toHaveBeenCalledTimes(1)
    expect(active.exec).not.toHaveBeenCalled()
  })

  it('queues a session-owned diagnostic whose wc resolves but whose session is not yet ready (pre-navigation window)', () => {
    const owning = makeWc()
    const diagnostics = makeFakeDiagnosticsBus()
    const fwd = createConsoleForwarder(
      { getServiceWc: () => null, getServiceWcForBridge: () => owning.wc },
      diagnostics as never,
    )

    diagnostics.report({ severity: 'error', code: 'x', message: 'm', appSessionId: 'session-A' })
    expect(owning.exec).not.toHaveBeenCalled()

    fwd.notifyServiceHostReady('session-A')
    expect(owning.exec).toHaveBeenCalledTimes(1)
  })

  it('falls back to getServiceWc() when appSessionId is absent', () => {
    const active = makeWc()
    const diagnostics = makeFakeDiagnosticsBus()
    createConsoleForwarder(
      { getServiceWc: () => active.wc, getServiceWcForBridge: () => null },
      diagnostics as never,
    )

    diagnostics.report({ severity: 'error', code: 'x', message: 'm' })

    expect(active.exec).toHaveBeenCalledTimes(1)
  })

  it('queues a session-owned diagnostic whose session does not resolve — never leaks it into the active host', () => {
    // Ownership invariant: while a spawn is in flight the "active" host is the
    // OUTGOING session's window; injecting there would put the message in a
    // console about to be destroyed. The diagnostic must wait for its own
    // session's host and flush on notifyServiceHostReady.
    const active = makeWc()
    const owning = makeWc()
    const diagnostics = makeFakeDiagnosticsBus()
    let sessionUp = false
    const fwd = createConsoleForwarder(
      {
        getServiceWc: () => active.wc,
        getServiceWcForBridge: (id) => (sessionUp && id === 'session-B' ? owning.wc : null),
      },
      diagnostics as never,
    )

    diagnostics.report({ severity: 'error', code: 'x', message: 'm', appSessionId: 'session-B' })
    expect(active.exec).not.toHaveBeenCalled()
    expect(owning.exec).not.toHaveBeenCalled()

    sessionUp = true
    fwd.notifyServiceHostReady('session-B')
    expect(owning.exec).toHaveBeenCalledTimes(1)
    expect(active.exec).not.toHaveBeenCalled()
  })
})

describe('createConsoleForwarder(bridge, diagnostics) — queue + notifyServiceHostReady', () => {
  it('queues (does not inject) a diagnostic reported while no wc resolves for its session', () => {
    const diagnostics = makeFakeDiagnosticsBus()
    const fwd = createConsoleForwarder(
      { getServiceWc: () => null, getServiceWcForBridge: () => null },
      diagnostics as never,
    )
    expect(typeof fwd.notifyServiceHostReady).toBe('function')

    // No target wc exists yet anywhere — must not throw, must not inject.
    expect(() => {
      diagnostics.report({ severity: 'error', code: 'x', message: 'm', appSessionId: 'session-A' })
    }).not.toThrow()
  })

  it('queues a diagnostic reported while the resolved wc is destroyed, then flushes it on notifyServiceHostReady', () => {
    const target = makeWc()
    target.destroy()
    const diagnostics = makeFakeDiagnosticsBus()
    const fwd = createConsoleForwarder(
      { getServiceWc: () => null, getServiceWcForBridge: () => target.wc },
      diagnostics as never,
    )

    diagnostics.report({ severity: 'error', code: 'x', message: 'queued-while-destroyed', appSessionId: 'session-A' })
    expect(target.exec).not.toHaveBeenCalled()

    fwd.notifyServiceHostReady('session-A')

    expect(target.exec).toHaveBeenCalledTimes(1)
    expect(String(target.exec.mock.calls[0]![0])).toContain('queued-while-destroyed')
  })

  it('flushes queued global diagnostics (no appSessionId) into the session that becomes ready', () => {
    const target = makeWc()
    target.destroy()
    const diagnostics = makeFakeDiagnosticsBus()
    const fwd = createConsoleForwarder(
      { getServiceWc: () => null, getServiceWcForBridge: () => target.wc },
      diagnostics as never,
    )

    // A global diagnostic (no appSessionId) reported before ANY session is ready.
    diagnostics.report({ severity: 'warn', code: 'global-x', message: 'global-queued' })

    fwd.notifyServiceHostReady('session-A')

    expect(target.exec).toHaveBeenCalledTimes(1)
    expect(String(target.exec.mock.calls[0]![0])).toContain('global-queued')
  })

  it('does not re-inject already-flushed diagnostics on a second notifyServiceHostReady for the same session', () => {
    const target = makeWc()
    target.destroy()
    const diagnostics = makeFakeDiagnosticsBus()
    const fwd = createConsoleForwarder(
      { getServiceWc: () => null, getServiceWcForBridge: () => target.wc },
      diagnostics as never,
    )

    diagnostics.report({ severity: 'error', code: 'x', message: 'once-only', appSessionId: 'session-A' })
    fwd.notifyServiceHostReady('session-A')
    fwd.notifyServiceHostReady('session-A')

    expect(target.exec).toHaveBeenCalledTimes(1)
  })
})

describe('createConsoleForwarder(bridge, diagnostics) — audience gating', () => {
  it('does NOT inject an audience:"internal" diagnostic into a resolved, ready service host', () => {
    const target = makeWc()
    const diagnostics = makeFakeDiagnosticsBus()
    const fwd = createConsoleForwarder(
      { getServiceWc: () => target.wc, getServiceWcForBridge: () => target.wc },
      diagnostics as never,
    )
    fwd.notifyServiceHostReady('session-A')

    diagnostics.report({
      severity: 'info',
      code: 'compile-standby',
      message: 'compile standby spawned pid=89193',
      appSessionId: 'session-A',
      audience: 'internal',
    })

    expect(target.exec).not.toHaveBeenCalled()
  })

  it('does NOT inject a session-less audience:"internal" diagnostic even when the active service host resolves', () => {
    const active = makeWc()
    const diagnostics = makeFakeDiagnosticsBus()
    createConsoleForwarder(
      { getServiceWc: () => active.wc, getServiceWcForBridge: () => null },
      diagnostics as never,
    )

    diagnostics.report({
      severity: 'info',
      code: 'compile-standby',
      message: 'compile standby prewarmed pid=89193',
      audience: 'internal',
    })

    expect(active.exec).not.toHaveBeenCalled()
  })

  it('never queues an audience:"internal" diagnostic — a later notifyServiceHostReady for its session does not retroactively inject it', () => {
    // If handleDiagnostic queued internal diagnostics like user ones, this would
    // catch it: the host is unresolvable at report() time, then becomes
    // resolvable once notifyServiceHostReady fires for that session.
    const owning = makeWc()
    const diagnostics = makeFakeDiagnosticsBus()
    const fwd = createConsoleForwarder(
      { getServiceWc: () => null, getServiceWcForBridge: (id) => (id === 'session-A' ? owning.wc : null) },
      diagnostics as never,
    )

    diagnostics.report({
      severity: 'info',
      code: 'compile-standby',
      message: 'compile standby adopted pid=89193',
      appSessionId: 'session-A',
      audience: 'internal',
    })
    fwd.notifyServiceHostReady('session-A')

    expect(owning.exec).not.toHaveBeenCalled()
  })

  it.each([
    ['user' as const, 'explicit audience:"user"'],
    [undefined, 'omitted audience'],
  ])('injects exactly like before when audience is %s (%s)', (audience: 'user' | undefined, _label: string) => {
    const target = makeWc()
    const diagnostics = makeFakeDiagnosticsBus()
    createConsoleForwarder(
      { getServiceWc: () => target.wc, getServiceWcForBridge: () => null },
      diagnostics as never,
    )

    diagnostics.report({ severity: 'error', code: 'page-not-found', message: 'Page[pages/x/x] not found', audience })

    expect(target.exec).toHaveBeenCalledTimes(1)
    expect(String(target.exec.mock.calls[0]![0])).toContain('Page[pages/x/x] not found')
  })

  it('an audience:"internal" diagnostic reported while no host resolves anywhere must not throw', () => {
    const diagnostics = makeFakeDiagnosticsBus()
    createConsoleForwarder(
      { getServiceWc: () => null, getServiceWcForBridge: () => null },
      diagnostics as never,
    )

    expect(() => {
      diagnostics.report({ severity: 'info', code: 'compile-standby', message: 'compile standby spawned pid=1', audience: 'internal' })
    }).not.toThrow()
  })
})

describe('createConsoleForwarder — existing render/service emit() behavior does not regress', () => {
  it('still mirrors a source:"render" emit() entry into the service host (unaffected by a diagnostics bus being wired)', () => {
    const target = makeWc()
    const diagnostics = makeFakeDiagnosticsBus()
    const fwd = createConsoleForwarder(
      { getServiceWc: () => target.wc, getServiceWcForBridge: () => null },
      diagnostics as never,
    )

    fwd.emit({ source: 'render', level: 'log', args: ['hello'] })

    expect(target.exec).toHaveBeenCalledTimes(1)
    expect(String(target.exec.mock.calls[0]![0])).toContain('[视图]')
  })

  it('still does NOT inject a source:"service" emit() entry (loop-safety unchanged by a diagnostics bus being wired)', () => {
    const target = makeWc()
    const diagnostics = makeFakeDiagnosticsBus()
    const fwd = createConsoleForwarder(
      { getServiceWc: () => target.wc, getServiceWcForBridge: () => null },
      diagnostics as never,
    )

    fwd.emit({ source: 'service', level: 'error', args: ['native'] })

    expect(target.exec).not.toHaveBeenCalled()
  })
})
