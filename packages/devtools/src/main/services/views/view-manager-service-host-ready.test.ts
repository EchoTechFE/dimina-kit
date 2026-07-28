/**
 * `ServiceHostReadyEvent` consumer contracts for the right-panel DevTools
 * host (`onNativeServiceHostReady` + the wall-clock-bounded fallback poll in
 * native-simulator-devtools-host.ts). Split from
 * view-manager-devtools-host-repoint.test.ts to keep each file under the
 * repo's 500-line ratchet; harness (electron mock, makeContext,
 * makeServiceWc) lives in view-manager-devtools-host-test-fixtures.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('electron', async () =>
  (await import('./view-manager-devtools-host-test-fixtures.js')).electronModuleMock())
vi.mock('../../utils/paths.js', async () =>
  (await import('./view-manager-devtools-host-test-fixtures.js')).pathsModuleMock())

import { createViewManager } from './view-manager.js'
import {
  constructed,
  makeContext,
  makeServiceWc,
  SIM_URL,
} from './view-manager-devtools-host-test-fixtures.js'

beforeEach(() => {
  constructed.length = 0
  // Fake timers: the fallback-poll contracts below advance virtual time, and
  // elements-forward's 150ms self-healing reconcile interval (installed on
  // every DevTools host attach) must never actually fire mid-test.
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})
/**
 * `ServiceHostReadyEvent` (`ctx.bridge.onServiceHostReady`) — the fix for a
 * real production bug: the right-panel DevTools attach used to rely SOLELY
 * on a `RenderEvent` (`domReady`/`activePage`) plus a fixed 20×50ms (1s)
 * retry poll of `getServiceWc`, silently and PERMANENTLY giving up if the
 * service host wasn't resolvable within that window (real machine load was
 * confirmed, via reproduction + timing instrumentation, to exceed it). This
 * event fires the moment the service host is GUARANTEED resolvable —
 * `native-simulator-devtools-host.ts`'s `onNativeServiceHostReady` resolves
 * it directly via `webContents.fromId(event.serviceWcId)`, validated against
 * the `getServiceWc` authority before acting (an authority that resolves
 * NOTHING fails open — the event is then the only signal available; a
 * CONTRADICTING authority means a superseded session's late ready, which is
 * dropped — see the gate describe below).
 */
describe('ServiceHostReadyEvent: attaches immediately, independent of any RenderEvent', () => {
  it('attaches to the service host the moment onServiceHostReady fires, with no RenderEvent at all', () => {
    const { ctx, emitServiceHostReady } = makeContext()
    const mgr = createViewManager(ctx)
    const service = makeServiceWc(201)

    mgr.attachNativeSimulator(SIM_URL, 375)
    // Attach alone (no active service wc set, no RenderEvent) must not have
    // pointed at anything yet — nothing to resolve.
    expect(service.setDevToolsWebContents).not.toHaveBeenCalled()

    emitServiceHostReady({ appId: 'repoint', appSessionId: 'b1', serviceWcId: service.id })

    expect(service.setDevToolsWebContents).toHaveBeenCalledTimes(1)
    expect(service.openDevTools).toHaveBeenCalledTimes(1)
  })

  it('rebuilds the DevTools host (does not re-point an already-navigated one) when a SECOND onServiceHostReady names a different service wc', () => {
    const { ctx, emitServiceHostReady } = makeContext()
    const mgr = createViewManager(ctx)
    const serviceA = makeServiceWc(204)
    const serviceB = makeServiceWc(205)

    mgr.attachNativeSimulator(SIM_URL, 375)
    emitServiceHostReady({ appId: 'repoint', appSessionId: 'b1', serviceWcId: serviceA.id })
    emitServiceHostReady({ appId: 'repoint', appSessionId: 'b2', serviceWcId: serviceB.id })

    const targetedHostCounts = new Map<unknown, number>()
    for (const serviceWc of [serviceA, serviceB]) {
      for (const call of serviceWc.setDevToolsWebContents.mock.calls) {
        const target = call[0]
        targetedHostCounts.set(target, (targetedHostCounts.get(target) ?? 0) + 1)
      }
    }
    for (const count of targetedHostCounts.values()) {
      expect(count).toBeLessThanOrEqual(1)
    }
    expect(serviceA.setDevToolsWebContents).toHaveBeenCalledTimes(1)
    expect(serviceB.setDevToolsWebContents).toHaveBeenCalledTimes(1)
  })

  it('does not throw and does not attach when the event names a wc id that no longer resolves (destroyed/unknown)', () => {
    const { ctx, emitServiceHostReady } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.attachNativeSimulator(SIM_URL, 375)

    expect(() => {
      emitServiceHostReady({ appId: 'repoint', appSessionId: 'ghost', serviceWcId: 999999 })
    }).not.toThrow()
  })
})

/**
 * Fallback poll retry bound: the production bug this whole event was added
 * to fix. `scheduleNativeDevtoolsFollow` used to give up permanently after a
 * fixed 20×50ms (1s) budget if `getServiceWc` never resolved in time — real
 * machine load was confirmed to exceed that. The fix bounds the fallback by
 * WALL-CLOCK time instead (`NATIVE_DEVTOOLS_FALLBACK_POLL_MAX_MS`, far more
 * generous), so a service host that only becomes resolvable well past the
 * OLD 1-second cutoff still gets attached instead of being silently and
 * permanently stranded.
 */
describe('fallback poll retry: bounded by wall-clock time, not a small fixed attempt count', () => {
  it('still attaches when getServiceWc only starts resolving well past the OLD 1-second cutoff', () => {
    const { ctx, setActiveServiceWc, emitRenderEvent } = makeContext()
    const mgr = createViewManager(ctx)
    const service = makeServiceWc(206)

    mgr.attachNativeSimulator(SIM_URL, 375)
    // getServiceWc currently resolves null — RenderEvent fires anyway (the
    // real race this fallback exists for: the render guest is ready before
    // the service host itself is).
    emitRenderEvent({ kind: 'domReady', appId: 'repoint', bridgeId: 'b1' })
    expect(service.setDevToolsWebContents).not.toHaveBeenCalled()

    // Advance well past the OLD fixed cap (20×50ms = 1000ms) — under the old
    // code this retry chain would already have permanently given up.
    vi.advanceTimersByTime(2_000)
    expect(
      service.setDevToolsWebContents,
      'sanity: still not attached because getServiceWc still resolves null — the retry must still be alive to attach once it does',
    ).not.toHaveBeenCalled()

    // The service host becomes resolvable now (2s+ after the render event) —
    // simulating exactly the slow-machine condition that stranded the
    // attachment before this fix.
    setActiveServiceWc(service)
    vi.advanceTimersByTime(100)

    expect(service.setDevToolsWebContents).toHaveBeenCalledTimes(1)
  })
})

/**
 * `onNativeServiceHostReady` must validate the event against the CURRENTLY-
 * active service host (`ctx.bridge.getServiceWc()`, the active-app authority)
 * before repointing. An event naming a wc id that is NOT what `getServiceWc()`
 * currently returns — a stale respawn's late-arriving ready, or a ready fired
 * for an app that is no longer the active one — must be a complete no-op: no
 * repoint at all, not even at whatever IS currently active.
 */
describe('ServiceHostReadyEvent: gated on matching the currently-active service wc', () => {
  it('ignores a ready event whose serviceWcId does not match ctx.bridge.getServiceWc()\'s current wc', () => {
    const { ctx, setActiveServiceWc, emitServiceHostReady } = makeContext()
    const mgr = createViewManager(ctx)
    const activeSession = makeServiceWc(501)
    const staleSession = makeServiceWc(502)

    mgr.attachNativeSimulator(SIM_URL, 375)
    setActiveServiceWc(activeSession)

    emitServiceHostReady({ appId: 'repoint', appSessionId: 'stale', serviceWcId: staleSession.id })

    expect(
      staleSession.setDevToolsWebContents,
      'a ready event naming a wc other than the active session\'s current service wc must be ignored, not repointed',
    ).not.toHaveBeenCalled()
    expect(
      activeSession.setDevToolsWebContents,
      'a mismatched ready event is a full no-op — it must not repoint at the active session either',
    ).not.toHaveBeenCalled()
  })

  it('repoints when the ready event\'s serviceWcId matches ctx.bridge.getServiceWc()\'s current wc', () => {
    const { ctx, setActiveServiceWc, emitServiceHostReady } = makeContext()
    const mgr = createViewManager(ctx)
    const activeSession = makeServiceWc(503)

    mgr.attachNativeSimulator(SIM_URL, 375)
    setActiveServiceWc(activeSession)

    emitServiceHostReady({ appId: 'repoint', appSessionId: 'current', serviceWcId: activeSession.id })

    expect(activeSession.setDevToolsWebContents).toHaveBeenCalledTimes(1)
    expect(activeSession.openDevTools).toHaveBeenCalledTimes(1)
  })
})

/**
 * A ready event that passes the active-wc match check but whose repoint
 * action itself throws (`setDevToolsWebContents` mid-teardown race) must NOT
 * cancel the standing fallback poll — only a SUCCESSFUL repoint may retire it.
 * Otherwise a validated-but-failed ready permanently strands the attachment:
 * the poll that would have retried and eventually succeeded gets cancelled by
 * the very event that failed to do the job itself.
 */
describe('ServiceHostReadyEvent: a failed repoint must not cancel the fallback poll', () => {
  it('still attaches via the fallback poll after a validated ready event whose repoint attempt throws', () => {
    const { ctx, setActiveServiceWc, emitServiceHostReady } = makeContext()
    const mgr = createViewManager(ctx)
    const service = makeServiceWc(504)
    service.setDevToolsWebContents.mockImplementationOnce(() => {
      throw new Error('setDevToolsWebContents failed (simulated mid-point teardown)')
    })

    mgr.attachNativeSimulator(SIM_URL, 375)
    // No active service wc yet at attach time — attach's own initial follow
    // arms the fallback poll (dormant under fake timers until advanced below).
    setActiveServiceWc(service)

    emitServiceHostReady({ appId: 'repoint', appSessionId: 'b1', serviceWcId: service.id })

    expect(
      service.setDevToolsWebContents,
      'the ready event matched the active session and attempted a repoint, which threw',
    ).toHaveBeenCalledTimes(1)

    // The fallback poll armed before the ready event must still be alive:
    // advancing past its interval must retry, and this time succeed (the
    // mocked throw was one-shot).
    vi.advanceTimersByTime(200)

    expect(
      service.setDevToolsWebContents,
      'a repoint failure on a validated ready event must not cancel the standing fallback poll — it must still retry and eventually attach',
    ).toHaveBeenCalledTimes(2)
  })
})
