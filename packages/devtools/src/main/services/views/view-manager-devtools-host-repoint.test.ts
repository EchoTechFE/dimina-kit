/**
 * Simulator-DevTools host: re-point onto a swapped service-host wc must reuse
 * the DevTools front-end host WITHOUT calling `setDevToolsWebContents` on it a
 * second time.
 *
 * Contract (Electron): `webContents.setDevToolsWebContents(hostWc)` requires
 * `hostWc` to have NEVER navigated. `pointNativeDevtoolsAtServiceWc` (view-
 * manager.ts ~1187) points the right-panel DevTools front-end host
 * (`simulatorView.webContents`) at the SERVICE-HOST wc (`next`) via
 * `next.setDevToolsWebContents(simulatorView.webContents)` +
 * `next.openDevTools({mode:'detach', activate:false})`. The first point loads
 * the DevTools front-end into that host wc — a navigation. When the
 * pre-warm pool swaps the service-host wc (`ctx.bridge.getServiceWc()` returns
 * a wc with a different `id`), `onNativeRenderEvent` →
 * `followNativeDevtoolsServiceHost` → `pointNativeDevtoolsAtActiveServiceHost`
 * re-invoke `pointNativeDevtoolsAtServiceWc` on the SAME, already-navigated
 * `simulatorView.webContents`.
 *
 * Bug this guards against: a second `setDevToolsWebContents` +
 * `openDevTools({mode:'detach'})` on the same already-navigated host wc
 * violates Electron's contract — the custom host stops being honoured and
 * Chrome DevTools tears out into an independent floating window instead of
 * staying embedded in the right panel.
 *
 * Fixed contract: the DevTools front-end host is a one-shot resource per
 * service-wc generation. Re-pointing to a new service wc (pool swap) must
 * REBUILD the host (`simulatorView`) — a fresh, never-navigated
 * `WebContentsView` — rather than calling `setDevToolsWebContents` again on
 * the wc that already hosted a previous generation.
 *
 * Harness (electron mock, makeContext, makeServiceWc) lives in
 * view-manager-devtools-host-test-fixtures.ts, shared with
 * view-manager-service-host-ready.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('electron', async () =>
  (await import('./view-manager-devtools-host-test-fixtures.js')).electronModuleMock())
vi.mock('../../utils/paths.js', async () =>
  (await import('./view-manager-devtools-host-test-fixtures.js')).pathsModuleMock())

import { createViewManager } from './view-manager.js'
import { simulatorDevtoolsBounds } from './placement-test-driver.js'
import {
  constructed,
  makeContext,
  makeServiceWc,
  SIM_URL,
  type StubView,
  type StubWebContents,
} from './view-manager-devtools-host-test-fixtures.js'
beforeEach(() => {
  constructed.length = 0
  // elements-forward installs a 150ms self-healing reconcile `setInterval`
  // (drain outbound queue / re-assert the front-end hook) on every DevTools
  // host attach. Fake timers keep it from ever actually firing mid-test —
  // every callback in it is best-effort/guarded, but there is no reason to pay
  // for a live timer in a synchronous assertion test.
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

/** All addChildView calls that targeted `view`. */
function addsOf(addChildView: ReturnType<typeof vi.fn>, view: StubView): unknown[][] {
  return addChildView.mock.calls.filter((c) => c[0] === view)
}

describe('DevTools front-end host wc: one-shot setDevToolsWebContents across service-wc pool swaps', () => {
  it('never calls setDevToolsWebContents twice on the same DevTools host wc across ≥2 service-wc swaps', () => {
    const { ctx, setActiveServiceWc, emitRenderEvent } = makeContext()
    const mgr = createViewManager(ctx)

    const serviceA = makeServiceWc(101)
    const serviceB = makeServiceWc(102)
    const serviceC = makeServiceWc(103)
    setActiveServiceWc(serviceA)

    mgr.attachNativeSimulator(SIM_URL, 375)

    // [0] = native simulator content view, [1] = DevTools front-end host view.
    expect(constructed.length).toBeGreaterThanOrEqual(2)

    // First point: attachNativeSimulator already resolves+points at the active
    // service host (serviceA) via followNativeDevtoolsServiceHost().
    expect(serviceA.setDevToolsWebContents).toHaveBeenCalledTimes(1)

    // Pool swap #1: a render event arrives naming a NEW service-host wc.
    setActiveServiceWc(serviceB)
    emitRenderEvent({ kind: 'activePage', appId: 'repoint', bridgeId: 'b1' })

    // Pool swap #2: another render event names YET ANOTHER service-host wc.
    setActiveServiceWc(serviceC)
    emitRenderEvent({ kind: 'domReady', appId: 'repoint', bridgeId: 'b2' })

    // `setDevToolsWebContents` is called ON the service wc, with the DevTools
    // front-end HOST wc (`simulatorView.webContents`) as its ARGUMENT. Collect
    // every (targetHostWc) argument across all three service wc's calls and
    // assert no single host wc instance is ever targeted more than once —
    // Electron's contract forbids re-pointing devtools at an already-navigated
    // host; a host wc appearing as the argument twice IS the bug (the custom
    // host stops being honoured and DevTools tears out into an independent
    // floating window on the second call).
    const targetedHostCounts = new Map<unknown, number>()
    for (const serviceWc of [serviceA, serviceB, serviceC]) {
      for (const call of serviceWc.setDevToolsWebContents.mock.calls) {
        const target = call[0]
        targetedHostCounts.set(target, (targetedHostCounts.get(target) ?? 0) + 1)
      }
    }
    for (const [target, count] of targetedHostCounts) {
      const hostId = (target as StubWebContents | undefined)?.id
      expect(
        count,
        `DevTools front-end host wc #${hostId} was passed to setDevToolsWebContents ${count} times — Electron forbids re-pointing devtools at an already-navigated host wc`,
      ).toBeLessThanOrEqual(1)
    }

    // Each of the THREE distinct service-host wc's was pointed at devtools
    // exactly once (once per swap) — the swaps did drive re-pointing.
    expect(serviceA.setDevToolsWebContents).toHaveBeenCalledTimes(1)
    expect(serviceB.setDevToolsWebContents).toHaveBeenCalledTimes(1)
    expect(serviceC.setDevToolsWebContents).toHaveBeenCalledTimes(1)

    // The fixed contract additionally requires the HOST to be rebuilt (a new,
    // never-navigated WebContentsView) on each re-point rather than reused —
    // i.e. at least 3 distinct DevTools-host-shaped views should have been
    // constructed (native simulator view + one host per generation).
    expect(
      constructed.length,
      'each service-wc swap must rebuild a fresh (never-navigated) DevTools front-end host view instead of reusing the one that already hosted a previous generation',
    ).toBeGreaterThanOrEqual(4) // 1 native simulator view + 3 devtools host generations
  })
})

describe('DevTools front-end host view: the rebuilt host is re-attached to contentView', () => {
  it('re-attaches the rebuilt DevTools host view after a service-wc swap triggers rebuildDevtoolsHostView', () => {
    // Guards `removeSimulatorDevtoolsView`'s
    // `placementState.actual.delete(VIEW_ID.simulatorDevtools)` (view-manager.ts):
    // `rebuildDevtoolsHostView` manually `removeChildView`s the outgoing host —
    // bypassing the level-triggered reconciler's own `detach` op — then builds a
    // fresh `WebContentsView` for the new host. The reconciler's
    // `placementState.actual` map is the single source of truth for "is
    // VIEW_ID.simulatorDevtools currently attached"; if the rebuild does not
    // also forget that record, the next `reconcileNow()` (fired at the end of
    // `rebuildDevtoolsHostView`) still believes the (now-destroyed) old host is
    // attached, never emits an `attach` op for the rebuilt host, and
    // `addChildView` is never called on it — embedded but invisible, mirroring
    // the simulator-view relaunch bug.
    const { ctx, addChildView, setActiveServiceWc, emitRenderEvent } = makeContext()
    const mgr = createViewManager(ctx)

    const serviceA = makeServiceWc(301)
    const serviceB = makeServiceWc(302)
    setActiveServiceWc(serviceA)

    mgr.attachNativeSimulator(SIM_URL, 375)
    // [0] = native simulator content view, [1] = the first DevTools host view.
    expect(constructed.length).toBeGreaterThanOrEqual(2)
    const firstDevtoolsHost = constructed[1]!

    // Publish a non-zero rect for the devtools panel: the level-triggered
    // reconciler attaches (addChildView) the first DevTools host view.
    simulatorDevtoolsBounds(mgr, { x: 400, y: 0, width: 400, height: 812 })
    expect(
      addsOf(addChildView, firstDevtoolsHost).length,
      'the first DevTools host view must mount once a non-zero rect is published',
    ).toBe(1)

    // Pool swap: a render event names a NEW service-host wc. `devtoolsHostUsed`
    // is already true from the point above, so `pointNativeDevtoolsAtServiceWc`
    // rebuilds the host (`rebuildDevtoolsHostView`) instead of re-pointing the
    // same one. Nothing re-publishes a fresh placement for
    // `simulatorDevtools` around this swap — the level-triggered `baseDesired`
    // table simply carries the prior (visible) value forward, mirroring the
    // simulator relaunch case in the sibling test file.
    setActiveServiceWc(serviceB)
    emitRenderEvent({ kind: 'activePage', appId: 'repoint', bridgeId: 'b1' })

    expect(
      constructed.length,
      'the service-wc swap must rebuild a fresh DevTools host view',
    ).toBe(3)
    const rebuiltDevtoolsHost = constructed[2]!
    expect(rebuiltDevtoolsHost).not.toBe(firstDevtoolsHost)

    expect(
      addsOf(addChildView, rebuiltDevtoolsHost).length,
      'the rebuilt DevTools host view must be re-attached to contentView — the reconciler must not still believe the destroyed outgoing host is attached',
    ).toBe(1)
  })
})

