import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildElementsHookScript,
  installElementsForward,
  isRenderEventMethod,
  routeByDomain,
} from './index.js'

// ── electron mock ──────────────────────────────────────────────────────────────
// The feature lazily `require('electron').webContents.fromId(id)` in
// detachSelfAttached. Back it with a registry the fakes populate so a self-
// attached guest can be resolved (and detached) on dispose.
const wcRegistry = new Map<number, unknown>()
vi.mock('electron', () => ({
  webContents: {
    fromId: (id: number) => wcRegistry.get(id) ?? null,
  },
}))

beforeEach(() => {
  wcRegistry.clear()
})

// ── routing table ───────────────────────────────────────────────────────────────

describe('routeByDomain (routing table)', () => {
  it('routes the Elements-tree domains to the render guest', () => {
    for (const method of [
      'DOM.getDocument',
      'DOM.requestChildNodes',
      'CSS.getMatchedStylesForNode',
      'CSS.getComputedStyleForNode',
      'Overlay.highlightNode',
      'Overlay.setInspectMode',
      'DOMSnapshot.captureSnapshot',
      'DOMDebugger.getEventListeners',
    ]) {
      expect(routeByDomain(method)).toBe('render')
    }
  })

  it('RED LINE: Emulation.* stays on the SERVICE host (never render)', () => {
    expect(routeByDomain('Emulation.setSafeAreaInsetsOverride')).toBe('service')
    expect(routeByDomain('Emulation.setDeviceMetricsOverride')).toBe('service')
    expect(routeByDomain('Emulation.clearDeviceMetricsOverride')).toBe('service')
  })

  it('keeps every service-owned domain on the service path', () => {
    for (const method of [
      'Runtime.evaluate',
      'Console.enable',
      'Debugger.enable',
      'Network.enable',
      'Page.navigate',
      'Target.attachToTarget',
      'Input.dispatchKeyEvent',
      'Profiler.start',
      'Log.enable',
    ]) {
      expect(routeByDomain(method)).toBe('service')
    }
  })

  it('anchors the prefix at the start (no mid-string mis-route)', () => {
    expect(routeByDomain('Page.setDOMCounter')).toBe('service')
    expect(routeByDomain('Runtime.evaluateDOM')).toBe('service')
  })

  it('isRenderEventMethod agrees with the render route', () => {
    expect(isRenderEventMethod('DOM.setChildNodes')).toBe(true)
    expect(isRenderEventMethod('Overlay.nodeHighlightRequested')).toBe(true)
    expect(isRenderEventMethod('Runtime.consoleAPICalled')).toBe(false)
  })
})

describe('buildElementsHookScript', () => {
  it('is an idempotent IIFE guarding on the install sentinel', () => {
    const src = buildElementsHookScript()
    expect(src.startsWith('(function(){')).toBe(true)
    expect(src).toContain('__diminaElementsHookInstalled')
    expect(src).toContain("return 'already'")
    expect(src).toContain("return 'partial'")
  })

  it('wraps sendMessageToBackend and pushes render commands to the outbound queue', () => {
    const src = buildElementsHookScript()
    expect(src).toContain('InspectorFrontendHost')
    expect(src).toContain('sendMessageToBackend')
    expect(src).toContain('__diminaElementsOutbound')
    expect(src).toContain('OUT.push')
    expect(src).toContain('DOM.')
    expect(src).toContain('CSS.')
    expect(src).toContain('Overlay.')
  })
})

// ── fakes ───────────────────────────────────────────────────────────────────────

function fakeDebugger(opts: {
  attached?: boolean
  sendCommand?: (method: string, params?: object) => Promise<unknown>
} = {}) {
  const messageHandlers: Array<(e: unknown, method: string, params: unknown) => void> = []
  let attached = opts.attached ?? true
  return {
    isAttached: vi.fn(() => attached),
    attach: vi.fn((_protocol: string) => { attached = true }),
    detach: vi.fn(() => { attached = false }),
    sendCommand: vi.fn(opts.sendCommand ?? (() => Promise.resolve({}))),
    on: vi.fn((event: string, cb: (e: unknown, method: string, params: unknown) => void) => {
      if (event === 'message') messageHandlers.push(cb)
    }),
    removeListener: vi.fn(),
    __emit(method: string, params: unknown) {
      for (const h of messageHandlers) h({}, method, params)
    },
  }
}

let nextWcId = 1
function fakeWc(overrides: Partial<Record<string, unknown>> = {}) {
  const handlers: Record<string, () => void> = {}
  const dbg = (overrides.debugger as ReturnType<typeof fakeDebugger>) ?? fakeDebugger()
  const wc = {
    id: (overrides.id as number) ?? nextWcId++,
    debugger: dbg,
    isDestroyed: vi.fn(() => false),
    isLoading: vi.fn(() => false),
    executeJavaScript: vi.fn(() => Promise.resolve('installed')),
    getURL: vi.fn(() => 'pageFrame.html?pagePath=pages/home/home'),
    once: vi.fn((event: string, cb: () => void) => { handlers[event] = cb }),
    removeListener: vi.fn(),
    __handlers: handlers,
    ...overrides,
  }
  wcRegistry.set(wc.id, wc)
  return wc
}

function fakeBridge(getActiveRenderWc: () => unknown) {
  const listeners = new Set<(e: unknown) => void>()
  return {
    getActiveRenderWc: vi.fn(getActiveRenderWc),
    onRenderEvent: vi.fn((cb: (e: unknown) => void) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    }),
    __emit(event: unknown) { for (const l of listeners) l(event) },
  }
}

// A bridge whose active render guest can be repointed between page switches.
// `setActive(wc)` flips the pointer; emit an `activePage` event to make the
// feature follow it. Models switchTab/navigateBack returning to an EXISTING,
// still-alive guest wc (render guests are reused, not destroyed, on tab swap).
function fakeSwitchableBridge(initial: unknown) {
  let active = initial
  const base = fakeBridge(() => active)
  return Object.assign(base, {
    setActive(wc: unknown) { active = wc },
  })
}

// A devtools host wc that drains a single outbound batch on the first 'splice'
// poll, then nothing. Other executeJavaScript calls (hook install, dispatch)
// resolve to a benign value.
function devtoolsWcDrainingOnce(batch: unknown[]) {
  let drained = false
  return fakeWc({
    executeJavaScript: vi.fn((src: string) => {
      if (src.includes('splice')) {
        if (drained) return Promise.resolve([])
        drained = true
        return Promise.resolve(batch)
      }
      if (src.includes('__diminaElementsHookInstalled')) return Promise.resolve('installed')
      return Promise.resolve(true)
    }),
  })
}

function dispatchedMatching(devtoolsWc: ReturnType<typeof fakeWc>, needle: string): string[] {
  return (devtoolsWc.executeJavaScript as ReturnType<typeof vi.fn>).mock.calls
    .map((c) => c[0] as string)
    .filter((s) => s.includes('dispatchMessage') && s.includes(needle))
}

// ── routing + id/sessionId passthrough ─────────────────────────────────────────

describe('installElementsForward — routing & passthrough', () => {
  it('forwards a render command to the active guest and dispatches the result back', async () => {
    vi.useFakeTimers()
    try {
      const guestDbg = fakeDebugger({
        sendCommand: vi.fn((method: string) =>
          method === 'DOM.getDocument'
            ? Promise.resolve({ root: { nodeId: 1 } })
            : Promise.resolve({})),
      })
      const guest = fakeWc({ debugger: guestDbg })
      const devtoolsWc = devtoolsWcDrainingOnce([
        { id: 7, method: 'DOM.getDocument', params: {}, sessionId: null },
      ])
      const bridge = fakeBridge(() => guest)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stop = installElementsForward({ devtoolsWc: devtoolsWc as any, bridge: bridge as any })

      await vi.advanceTimersByTimeAsync(400)

      expect(guestDbg.sendCommand).toHaveBeenCalledWith('DOM.getDocument', {})
      const dispatched = dispatchedMatching(devtoolsWc, '\\"id\\":7')
      expect(dispatched.length).toBeGreaterThan(0)
      expect(dispatched.some((s) => s.includes('result'))).toBe(true)
      stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('passes the front-end id + sessionId straight through (no mapping)', async () => {
    vi.useFakeTimers()
    try {
      const guest = fakeWc()
      const devtoolsWc = devtoolsWcDrainingOnce([
        { id: 42, method: 'DOM.getDocument', params: {}, sessionId: 'SESS-XYZ' },
      ])
      const bridge = fakeBridge(() => guest)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stop = installElementsForward({ devtoolsWc: devtoolsWc as any, bridge: bridge as any })

      await vi.advanceTimersByTimeAsync(400)

      const dispatched = dispatchedMatching(devtoolsWc, '\\"id\\":42')
      expect(dispatched.length).toBeGreaterThan(0)
      // The original sessionId is echoed back verbatim.
      expect(dispatched.some((s) => s.includes('SESS-XYZ'))).toBe(true)
      stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('replies with a CDP error when there is no active render guest', async () => {
    vi.useFakeTimers()
    try {
      const devtoolsWc = devtoolsWcDrainingOnce([
        { id: 9, method: 'DOM.getDocument', params: {}, sessionId: 'S1' },
      ])
      const bridge = fakeBridge(() => null)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stop = installElementsForward({ devtoolsWc: devtoolsWc as any, bridge: bridge as any })

      await vi.advanceTimersByTimeAsync(400)

      const errs = dispatchedMatching(devtoolsWc, '\\"id\\":9')
      expect(errs.length).toBeGreaterThan(0)
      expect(errs.some((s) => s.includes('no active render guest') && s.includes('-32000'))).toBe(true)
      stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('settles with an error when the guest is destroyed mid-sendCommand (no pending leak)', async () => {
    vi.useFakeTimers()
    try {
      const guestDbg = fakeDebugger({
        sendCommand: vi.fn(() => Promise.reject(new Error('Target closed'))),
      })
      const guest = fakeWc({ debugger: guestDbg })
      const devtoolsWc = devtoolsWcDrainingOnce([
        { id: 11, method: 'DOM.getDocument', params: {}, sessionId: null },
      ])
      const bridge = fakeBridge(() => guest)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stop = installElementsForward({ devtoolsWc: devtoolsWc as any, bridge: bridge as any })

      await vi.advanceTimersByTimeAsync(400)

      const errs = dispatchedMatching(devtoolsWc, '\\"id\\":11')
      expect(errs.some((s) => s.includes('Target closed') && s.includes('-32000'))).toBe(true)
      stop()
    } finally {
      vi.useRealTimers()
    }
  })
})

// ── generation isolation ──────────────────────────────────────────────────────

describe('installElementsForward — generation isolation', () => {
  // CORRECTED (by implementer, flagged): this test previously used a SINGLE-guest
  // bridge and fired `activePage` (which under the old `generation` counter bumped
  // staleness even though the active guest never changed), then asserted the
  // in-flight command errored. That fossilised the same over-eager-staleness
  // defect as B2/MINOR-3 — a no-op activePage to the SAME guest must NOT invalidate
  // its own in-flight command. The legitimate contract (consistent with the
  // independently-authored MINOR-3 test) is: a command errors only when the active
  // guest ACTUALLY changes to a DIFFERENT guest while it was in flight. We switch
  // to a separate `other` guest to express that.
  it('drops a late response after the active guest switched to a DIFFERENT guest', async () => {
    vi.useFakeTimers()
    try {
      let resolveDoc!: (v: unknown) => void
      const guestDbg = fakeDebugger({
        sendCommand: vi.fn((method: string) => {
          if (method === 'DOM.getDocument') {
            return new Promise((res) => { resolveDoc = res })
          }
          return Promise.resolve({})
        }),
      })
      const guest = fakeWc({ debugger: guestDbg })
      const other = fakeWc({ debugger: fakeDebugger() })
      const devtoolsWc = devtoolsWcDrainingOnce([
        { id: 5, method: 'DOM.getDocument', params: {}, sessionId: null },
      ])
      const bridge = fakeSwitchableBridge(guest)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stop = installElementsForward({ devtoolsWc: devtoolsWc as any, bridge: bridge as any })

      await vi.advanceTimersByTimeAsync(400)
      // Command is in flight on `guest`. Active page switches to a DIFFERENT guest.
      bridge.setActive(other)
      bridge.__emit({ kind: 'activePage', appId: 'a', bridgeId: 'b' })
      // The now-stale command finally resolves.
      resolveDoc({ root: { nodeId: 99 } })
      await vi.advanceTimersByTimeAsync(10)

      const forId5 = dispatchedMatching(devtoolsWc, '\\"id\\":5')
      expect(forId5.length).toBeGreaterThan(0)
      // Settled as an error (its guest is no longer active), never as a result.
      expect(forId5.some((s) => s.includes('stale render generation'))).toBe(true)
      expect(forId5.some((s) => s.includes('result') && s.includes('99'))).toBe(false)
      stop()
    } finally {
      vi.useRealTimers()
    }
  })

  // CORRECTED (B2): this test previously emitted from the *same* guest after an
  // activePage bump and asserted the event was DROPPED. That fossilised the B2
  // bug — with a single-guest bridge, an activePage event re-activates that very
  // guest, so its events must be RESTORED, not dropped. Asserting "dropped" there
  // locked in the stale-`wiredGen` defect. The legitimate scenario this test
  // *means* to cover is: a guest that is NO LONGER active (we switched to a
  // DIFFERENT guest) must not leak its events into the now-current tree. We make
  // that explicit by switching to a separate `other` guest before the stale emit.
  // (The "switch back to an old guest restores its events" contract now lives in
  // its own dedicated B2 test below.)
  it('drops a render EVENT from a guest that is no longer the active one', async () => {
    vi.useFakeTimers()
    try {
      const guestDbg = fakeDebugger({ attached: true })
      const guest = fakeWc({ debugger: guestDbg })
      const otherDbg = fakeDebugger({ attached: true })
      const other = fakeWc({ debugger: otherDbg })
      const devtoolsWc = devtoolsWcDrainingOnce([
        { id: 1, method: 'DOM.enable', params: {}, sessionId: null },
      ])
      const bridge = fakeSwitchableBridge(guest)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stop = installElementsForward({ devtoolsWc: devtoolsWc as any, bridge: bridge as any })

      await vi.advanceTimersByTimeAsync(400)

      // Event from the active guest is forwarded.
      guestDbg.__emit('DOM.setChildNodes', { tag: 'fresh' })
      await vi.advanceTimersByTimeAsync(5)
      expect(dispatchedMatching(devtoolsWc, 'fresh').length).toBeGreaterThan(0)

      // Switch to a DIFFERENT guest. The old `guest` is no longer active; any
      // event it now emits belongs to a tree the front-end has moved off and must
      // be dropped (must not bleed into `other`'s current tree).
      bridge.setActive(other)
      bridge.__emit({ kind: 'activePage', appId: 'a', bridgeId: 'b' })
      guestDbg.__emit('DOM.setChildNodes', { tag: 'stale' })
      await vi.advanceTimersByTimeAsync(5)
      expect(dispatchedMatching(devtoolsWc, 'stale').length).toBe(0)
      stop()
    } finally {
      vi.useRealTimers()
    }
  })

  // ── B2: re-activating an existing (reused) render guest restores its events ──
  // MAJOR bug B2: render guests are NOT destroyed on switchTab/navigateBack — the
  // target guest is an existing, alive, REUSED wc. When we switch A→B→A and land
  // back on the already-wired guest A, A's DOM-domain events must be re-injected
  // into the front-end again. The current impl snapshots `wiredGen` at first wire
  // and `wireGuestEvents` early-returns on re-prime (guest already in
  // `wiredGuests`), so A's listener keeps its stale generation and its events are
  // dropped FOREVER after the round-trip. This RED test pins the correct contract.
  it('B2: restores event forwarding when switching back to a previously-wired guest', async () => {
    vi.useFakeTimers()
    try {
      const aDbg = fakeDebugger({ attached: true })
      const guestA = fakeWc({ debugger: aDbg })
      const bDbg = fakeDebugger({ attached: true })
      const guestB = fakeWc({ debugger: bDbg })
      const devtoolsWc = devtoolsWcDrainingOnce([])
      const bridge = fakeSwitchableBridge(guestA)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stop = installElementsForward({ devtoolsWc: devtoolsWc as any, bridge: bridge as any })

      // 1. Initial active guest is A (wired on install).
      await vi.advanceTimersByTimeAsync(400)

      // A's events forward while it is active.
      aDbg.__emit('DOM.setChildNodes', { tag: 'A-first' })
      await vi.advanceTimersByTimeAsync(5)
      expect(dispatchedMatching(devtoolsWc, 'A-first').length).toBeGreaterThan(0)

      // 2. Switch to guest B.
      bridge.setActive(guestB)
      bridge.__emit({ kind: 'activePage', appId: 'a', bridgeId: 'b' })
      await vi.advanceTimersByTimeAsync(5)

      // 3. Switch BACK to the existing, reused guest A (navigateBack / switchTab).
      bridge.setActive(guestA)
      bridge.__emit({ kind: 'activePage', appId: 'a', bridgeId: 'b' })
      await vi.advanceTimersByTimeAsync(5)

      // 4. Guest A (now active again) emits a render-domain event.
      aDbg.__emit('DOM.setChildNodes', { tag: 'A-restored' })
      await vi.advanceTimersByTimeAsync(5)

      // 5. CONTRACT: A's event must be re-injected into the front-end. It is the
      // active tree again — dropping it (because A's first-wire generation is now
      // stale) is the B2 defect.
      expect(dispatchedMatching(devtoolsWc, 'A-restored').length).toBeGreaterThan(0)

      // Positive control (no over-correction): while A is active, B is NOT — a
      // stray event from the now-inactive B must still be dropped, so the fix
      // can't simply be "stop filtering entirely".
      bDbg.__emit('DOM.setChildNodes', { tag: 'B-leak' })
      await vi.advanceTimersByTimeAsync(5)
      expect(dispatchedMatching(devtoolsWc, 'B-leak').length).toBe(0)

      stop()
    } finally {
      vi.useRealTimers()
    }
  })

  // ── MINOR-3: destroying a non-active OLD guest must not error the ACTIVE
  // guest's in-flight routed command. `onDestroyed` bumps the global generation;
  // a too-coarse generation scheme would then settle the current guest's pending
  // response as 'stale render generation'. This pins that the active guest's
  // command still resolves with its real result. RED if the impl can't isolate.
  it('MINOR-3: destroying an old non-active guest does not stale the active guest command', async () => {
    vi.useFakeTimers()
    try {
      // The OLD guest A (will be destroyed mid-flight, while inactive).
      const aDbg = fakeDebugger({ attached: true })
      const guestA = fakeWc({ debugger: aDbg })

      // The ACTIVE guest B, whose DOM.getDocument is slow / in flight.
      let resolveDoc!: (v: unknown) => void
      const bDbg = fakeDebugger({
        sendCommand: vi.fn((method: string) => {
          if (method === 'DOM.getDocument') return new Promise((res) => { resolveDoc = res })
          return Promise.resolve({})
        }),
      })
      const guestB = fakeWc({ debugger: bDbg })

      // Drain B's DOM.getDocument only on the SECOND splice poll (after we've
      // switched to B), so the command is routed at B (the active guest).
      let calls = 0
      const devtoolsWc = fakeWc({
        executeJavaScript: vi.fn((src: string) => {
          if (src.includes('splice')) {
            calls++
            if (calls === 2) return Promise.resolve([{ id: 8, method: 'DOM.getDocument', params: {}, sessionId: null }])
            return Promise.resolve([])
          }
          if (src.includes('__diminaElementsHookInstalled')) return Promise.resolve('installed')
          return Promise.resolve(true)
        }),
      })
      const bridge = fakeSwitchableBridge(guestA)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stop = installElementsForward({ devtoolsWc: devtoolsWc as any, bridge: bridge as any })

      // Active guest starts as A (wired), then we move to B.
      await vi.advanceTimersByTimeAsync(200)
      bridge.setActive(guestB)
      bridge.__emit({ kind: 'activePage', appId: 'a', bridgeId: 'b' })

      // Let the second drain route DOM.getDocument at B → it is now in flight.
      await vi.advanceTimersByTimeAsync(400)
      expect(bDbg.sendCommand).toHaveBeenCalledWith('DOM.getDocument', {})

      // The OLD, now-inactive guest A is destroyed while B's command is pending.
      guestA.__handlers.destroyed?.()
      await vi.advanceTimersByTimeAsync(5)

      // B's command finally resolves — it is the ACTIVE guest and must get its
      // real result, NOT be settled as 'stale render generation'.
      resolveDoc({ root: { nodeId: 77 } })
      await vi.advanceTimersByTimeAsync(10)

      const forId8 = dispatchedMatching(devtoolsWc, '\\"id\\":8')
      expect(forId8.length).toBeGreaterThan(0)
      expect(forId8.some((s) => s.includes('result') && s.includes('77'))).toBe(true)
      expect(forId8.some((s) => s.includes('stale render generation'))).toBe(false)
      stop()
    } finally {
      vi.useRealTimers()
    }
  })
})

// ── self-attach tracking ──────────────────────────────────────────────────────

describe('installElementsForward — self-attach tracking', () => {
  it('REUSES an already-attached guest debugger: never attach, never detach', async () => {
    vi.useFakeTimers()
    try {
      const guestDbg = fakeDebugger({ attached: true })
      const guest = fakeWc({ debugger: guestDbg })
      const devtoolsWc = devtoolsWcDrainingOnce([
        { id: 1, method: 'DOM.getDocument', params: {}, sessionId: null },
      ])
      const bridge = fakeBridge(() => guest)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stop = installElementsForward({ devtoolsWc: devtoolsWc as any, bridge: bridge as any })

      await vi.advanceTimersByTimeAsync(400)

      expect(guestDbg.attach).not.toHaveBeenCalled()
      stop()
      // stop() must NOT detach a session safe-area owns.
      expect(guestDbg.detach).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('attaches ONLY when nobody has, and on dispose detaches ONLY its own', async () => {
    vi.useFakeTimers()
    try {
      const guestDbg = fakeDebugger({ attached: false })
      const guest = fakeWc({ debugger: guestDbg })
      const devtoolsWc = devtoolsWcDrainingOnce([
        { id: 2, method: 'DOM.getDocument', params: {}, sessionId: null },
      ])
      const bridge = fakeBridge(() => guest)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stop = installElementsForward({ devtoolsWc: devtoolsWc as any, bridge: bridge as any })

      await vi.advanceTimersByTimeAsync(400)

      expect(guestDbg.attach).toHaveBeenCalledWith('1.3')
      stop()
      // We own this session → dispose detaches it (the wc is still attached).
      expect(guestDbg.detach).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does NOT detach a self-attached session whose guest was already destroyed', async () => {
    vi.useFakeTimers()
    try {
      const guestDbg = fakeDebugger({ attached: false })
      const guest = fakeWc({ debugger: guestDbg })
      const devtoolsWc = devtoolsWcDrainingOnce([
        { id: 3, method: 'DOM.getDocument', params: {}, sessionId: null },
      ])
      const bridge = fakeBridge(() => guest)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stop = installElementsForward({ devtoolsWc: devtoolsWc as any, bridge: bridge as any })

      await vi.advanceTimersByTimeAsync(400)
      expect(guestDbg.attach).toHaveBeenCalledWith('1.3')

      // Guest destroyed: its 'destroyed' handler drops it from the self-attach set.
      guest.__handlers.destroyed?.()
      stop()
      expect(guestDbg.detach).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

// ── event re-injection + single subscription ───────────────────────────────────

describe('installElementsForward — event re-injection', () => {
  it('re-injects render-domain guest EVENTS into the front-end, ignores others', async () => {
    vi.useFakeTimers()
    try {
      const guestDbg = fakeDebugger({ attached: true })
      const guest = fakeWc({ debugger: guestDbg })
      const devtoolsWc = devtoolsWcDrainingOnce([
        { id: 1, method: 'DOM.enable', params: {}, sessionId: null },
      ])
      const bridge = fakeBridge(() => guest)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stop = installElementsForward({ devtoolsWc: devtoolsWc as any, bridge: bridge as any })

      await vi.advanceTimersByTimeAsync(400)

      guestDbg.__emit('DOM.setChildNodes', { parentId: 1, nodes: [] })
      guestDbg.__emit('Runtime.consoleAPICalled', { type: 'log' })
      await vi.advanceTimersByTimeAsync(10)

      const dispatched = (devtoolsWc.executeJavaScript as ReturnType<typeof vi.fn>).mock.calls
        .map((c) => c[0] as string)
        .filter((s) => s.includes('dispatchMessage'))
      expect(dispatched.some((s) => s.includes('DOM.setChildNodes'))).toBe(true)
      expect(dispatched.some((s) => s.includes('Runtime.consoleAPICalled'))).toBe(false)
      stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('only wires a guest message listener once across repeated commands', async () => {
    vi.useFakeTimers()
    try {
      const guestDbg = fakeDebugger({ attached: true })
      const guest = fakeWc({ debugger: guestDbg })
      let calls = 0
      const devtoolsWc = fakeWc({
        executeJavaScript: vi.fn((src: string) => {
          if (src.includes('splice')) {
            calls++
            if (calls === 1) return Promise.resolve([{ id: 1, method: 'DOM.getDocument', params: {}, sessionId: null }])
            if (calls === 2) return Promise.resolve([{ id: 2, method: 'DOM.getDocument', params: {}, sessionId: null }])
            return Promise.resolve([])
          }
          if (src.includes('__diminaElementsHookInstalled')) return Promise.resolve('installed')
          return Promise.resolve(true)
        }),
      })
      const bridge = fakeBridge(() => guest)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stop = installElementsForward({ devtoolsWc: devtoolsWc as any, bridge: bridge as any })

      await vi.advanceTimersByTimeAsync(600)

      const messageSubscriptions = (guestDbg.on as ReturnType<typeof vi.fn>).mock.calls
        .filter((c) => c[0] === 'message')
      expect(messageSubscriptions.length).toBe(1)
      stop()
    } finally {
      vi.useRealTimers()
    }
  })
})

// ── degradation ────────────────────────────────────────────────────────────────

describe('installElementsForward — degradation', () => {
  it('does not throw and stays inert when the front-end hook never installs', async () => {
    vi.useFakeTimers()
    try {
      const guest = fakeWc()
      const bridge = fakeBridge(() => guest)
      // Front-end never has the embedder global → hook returns 'partial' forever.
      const devtoolsWc = fakeWc({
        executeJavaScript: vi.fn((src: string) => {
          if (src.includes('__diminaElementsHookInstalled')) return Promise.resolve('partial')
          if (src.includes('splice')) return Promise.resolve([])
          return Promise.resolve(true)
        }),
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stop = installElementsForward({ devtoolsWc: devtoolsWc as any, bridge: bridge as any })
      // Run well past the install-poll budget; nothing should throw.
      await vi.advanceTimersByTimeAsync(5000)
      // No render command was ever routed at the guest (hook never armed).
      expect((guest.debugger.sendCommand as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0)
      stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('survives an executeJavaScript that rejects (booting / torn-down front-end)', async () => {
    vi.useFakeTimers()
    try {
      const guest = fakeWc()
      const bridge = fakeBridge(() => guest)
      const devtoolsWc = fakeWc({
        executeJavaScript: vi.fn(() => Promise.reject(new Error('Script failed to execute'))),
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stop = installElementsForward({ devtoolsWc: devtoolsWc as any, bridge: bridge as any })
      await vi.advanceTimersByTimeAsync(1000)
      // No throw; disposer is callable.
      expect(() => stop()).not.toThrow()
    } finally {
      vi.useRealTimers()
    }
  })
})

// ── disposer ─────────────────────────────────────────────────────────────────────

describe('installElementsForward — disposer', () => {
  it('stops timers (no further executeJavaScript) and unsubscribes render events', async () => {
    vi.useFakeTimers()
    try {
      const guest = fakeWc()
      const bridge = fakeBridge(() => guest)
      const devtoolsWc = fakeWc()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stop = installElementsForward({ devtoolsWc: devtoolsWc as any, bridge: bridge as any })
      await vi.advanceTimersByTimeAsync(200)
      const before = (devtoolsWc.executeJavaScript as ReturnType<typeof vi.fn>).mock.calls.length
      expect(before).toBeGreaterThan(0)
      stop()
      await vi.advanceTimersByTimeAsync(1000)
      expect((devtoolsWc.executeJavaScript as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before)
      // render-event subscription removed → emitting does nothing.
      bridge.__emit({ kind: 'activePage', appId: 'a', bridgeId: 'b' })
    } finally {
      vi.useRealTimers()
    }
  })
})
