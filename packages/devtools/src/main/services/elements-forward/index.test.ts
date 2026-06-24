import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createConnectionRegistry } from '@dimina-kit/electron-deck/main'
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

  it('routes Overlay.disable and Overlay.highlightNode to the render guest', () => {
    // The Elements highlight + its teardown both act on the render guest's
    // Overlay domain; both must reach the render debugger, never the service host.
    expect(routeByDomain('Overlay.highlightNode')).toBe('render')
    expect(routeByDomain('Overlay.disable')).toBe('render')
    expect(routeByDomain('Overlay.enable')).toBe('render')
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
    // Real WebContents exposes `on` (persistent) alongside `once`; elements-forward
    // now uses `on('dom-ready', …)` to re-install the hook on every front-end load.
    // Stash under the same `__handlers` map so a test can re-fire `dom-ready`.
    on: vi.fn((event: string, cb: () => void) => { handlers[event] = cb }),
    removeListener: vi.fn(),
    __handlers: handlers,
    ...overrides,
  }
  wcRegistry.set(wc.id, wc)
  return wc
}

// A render guest backed by a REAL EventEmitter so the connection registry's
// `wc.once('destroyed', …)` actually fires when we `emit('destroyed')`. Mirrors
// `fakeWc` otherwise (debugger, isDestroyed, etc.) and registers in wcRegistry so
// detachSelfAttached can resolve it by id.
function emitterWc(overrides: Partial<Record<string, unknown>> = {}) {
  const emitter = new EventEmitter()
  const dbg = (overrides.debugger as ReturnType<typeof fakeDebugger>) ?? fakeDebugger()
  let destroyed = false
  const wc = {
    id: (overrides.id as number) ?? nextWcId++,
    debugger: dbg,
    isDestroyed: vi.fn(() => destroyed),
    isLoading: vi.fn(() => false),
    executeJavaScript: vi.fn(() => Promise.resolve('installed')),
    getURL: vi.fn(() => 'pageFrame.html?pagePath=pages/home/home'),
    once: (event: string, cb: () => void) => { emitter.once(event, cb); return wc },
    on: (event: string, cb: () => void) => { emitter.on(event, cb); return wc },
    removeListener: (event: string, cb: () => void) => { emitter.removeListener(event, cb); return wc },
    emit: (event: string) => emitter.emit(event),
    __destroy() { destroyed = true; emitter.emit('destroyed') },
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
  // A no-op activePage to the SAME guest must NOT invalidate its own in-flight
  // command. A command errors only when the active guest ACTUALLY changes to a
  // DIFFERENT guest while it was in flight. We switch to a separate `other` guest
  // to express that.
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

  // A guest that is NO LONGER active (we switched to a DIFFERENT guest) must not
  // leak its events into the now-current tree. We make that explicit by switching
  // to a separate `other` guest before the stale emit. (The "switch back to an old
  // guest restores its events" contract lives in its own dedicated test below.)
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

  // ── re-activating an existing (reused) render guest restores its events ──
  // Render guests are NOT destroyed on switchTab/navigateBack — the target guest
  // is an existing, alive, REUSED wc. When we switch A→B→A and land back on the
  // already-wired guest A, A's DOM-domain events must be re-injected into the
  // front-end again. A scheme that snapshots a generation at first wire and
  // early-returns on re-prime would leave A's listener with a stale generation and
  // drop its events forever after the round-trip.
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
      // active tree again — dropping it because A's first-wire generation is now
      // stale is the defect this guards against.
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

  // Destroying a non-active OLD guest must not error the ACTIVE guest's in-flight
  // routed command. `onDestroyed` bumps the global generation; a too-coarse
  // generation scheme would then settle the current guest's pending response as
  // 'stale render generation'. The active guest's command must still resolve with
  // its real result.
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

// ── per-load re-arm (dom-ready re-installs the front-end hook) ──────────────────

// Count executeJavaScript calls that INSTALL the front-end hook. The install
// script (buildElementsHookScript) embeds the `__diminaElementsHookInstalled`
// sentinel; the splice-drain poll references `__diminaElementsOutbound` (no
// sentinel) and dispatch calls reference `dispatchMessage`. So filtering on the
// sentinel uniquely isolates install calls.
function hookInstallCount(devtoolsWc: ReturnType<typeof fakeWc>): number {
  return (devtoolsWc.executeJavaScript as ReturnType<typeof vi.fn>).mock.calls
    .filter((c) => (c[0] as string).includes('__diminaElementsHookInstalled')).length
}

describe('installElementsForward — per-load re-arm', () => {
  // The hook lives in the front-end's `globalThis`; a front-end reload (notably a
  // service-host pool swap that re-opens DevTools) wipes it. The feature uses a
  // PERSISTENT `on('dom-ready', …)` listener (not `once`) so it re-installs the
  // hook on EVERY load. This pins that contract: a second `dom-ready` produces a
  // fresh install call — proving it is not single-shot.
  it('re-installs the front-end hook on every dom-ready (not once)', async () => {
    vi.useFakeTimers()
    try {
      const guest = fakeWc()
      const devtoolsWc = devtoolsWcDrainingOnce([])
      const bridge = fakeBridge(() => guest)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stop = installElementsForward({ devtoolsWc: devtoolsWc as any, bridge: bridge as any })

      // First load's hook install runs (immediate onReady + install poll).
      await vi.advanceTimersByTimeAsync(400)
      const afterFirst = hookInstallCount(devtoolsWc)
      expect(afterFirst).toBeGreaterThan(0)

      // Front-end reloads → `dom-ready` fires again. A single-shot `once` listener
      // would NOT re-run; the persistent one re-arms a fresh install poll.
      devtoolsWc.__handlers['dom-ready']!()
      await vi.advanceTimersByTimeAsync(400)

      expect(hookInstallCount(devtoolsWc)).toBeGreaterThan(afterFirst)
      stop()
    } finally {
      vi.useRealTimers()
    }
  })

  // After dispose the `dom-ready` listener is removed (and the `disposed` guard
  // short-circuits `onReady`), so a stray reload must NOT re-install the hook.
  it('does not re-install after dispose (dom-ready listener removed)', async () => {
    vi.useFakeTimers()
    try {
      const guest = fakeWc()
      const devtoolsWc = devtoolsWcDrainingOnce([])
      const bridge = fakeBridge(() => guest)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stop = installElementsForward({ devtoolsWc: devtoolsWc as any, bridge: bridge as any })

      await vi.advanceTimersByTimeAsync(400)
      expect(hookInstallCount(devtoolsWc)).toBeGreaterThan(0)

      stop()
      const afterStop = hookInstallCount(devtoolsWc)

      // Reload after dispose → no new install call.
      devtoolsWc.__handlers['dom-ready']!()
      await vi.advanceTimersByTimeAsync(400)
      expect(hookInstallCount(devtoolsWc)).toBe(afterStop)
    } finally {
      vi.useRealTimers()
    }
  })

  // Re-arm must clear the prior load's timers before starting fresh ones, and
  // dispose must stop them all. After a re-arm + dispose, advancing time must NOT
  // drive any further executeJavaScript (no leaked install/drain interval).
  it('leaks no timers across re-arm + dispose', async () => {
    vi.useFakeTimers()
    try {
      const guest = fakeWc()
      const devtoolsWc = devtoolsWcDrainingOnce([])
      const bridge = fakeBridge(() => guest)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stop = installElementsForward({ devtoolsWc: devtoolsWc as any, bridge: bridge as any })

      await vi.advanceTimersByTimeAsync(400)
      devtoolsWc.__handlers['dom-ready']!() // re-arm a fresh load
      await vi.advanceTimersByTimeAsync(400)

      stop()
      const frozen = (devtoolsWc.executeJavaScript as ReturnType<typeof vi.fn>).mock.calls.length
      await vi.advanceTimersByTimeAsync(2000)
      expect((devtoolsWc.executeJavaScript as ReturnType<typeof vi.fn>).mock.calls.length).toBe(frozen)
    } finally {
      vi.useRealTimers()
    }
  })
})

// ── connection-registry-routed teardown ─────────────────────────────────────────

describe('installElementsForward — connection-routed teardown', () => {
  // When a `connections` registry is supplied, the per-guest `onDestroyed`
  // teardown is routed through `connections.acquire(wc).on('closed', cleanup)`
  // (the wc-lifetime hook) — NOT through `own()`, and NOT via a bespoke
  // `wc.once('destroyed')`. This MUST stay `on('closed')` and must NOT be changed
  // to `own()`: `own()`'s release handle FIRES the cleanup on dispose, which would
  // mutate `wiredGuests` mid-drain; render guests are NEVER pool-reset, so
  // `'closed'` (fires only on real wc destroy, and whose dispose() removes the
  // listener WITHOUT firing) is the correct lifetime hook here.
  // The observable contract is identical to the existing fallback path: a
  // self-attached guest that is destroyed is dropped from the self-attach set, so
  // a later stop() does NOT try to detach its (already-gone) session. If the
  // teardown were never wired through the connection, the guest would stay in
  // selfAttached and stop() would call detach() on it.
  it('routes guest onDestroyed through the connection registry (drops self-attach on destroy)', async () => {
    vi.useFakeTimers()
    try {
      const guestDbg = fakeDebugger({ attached: false }) // forces a self-attach
      const guest = emitterWc({ debugger: guestDbg })
      const devtoolsWc = devtoolsWcDrainingOnce([
        { id: 1, method: 'DOM.getDocument', params: {}, sessionId: null },
      ])
      const bridge = fakeBridge(() => guest)
      const connections = createConnectionRegistry()

      const stop = installElementsForward({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        devtoolsWc: devtoolsWc as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        bridge: bridge as any,
        connections,
      })

      await vi.advanceTimersByTimeAsync(400)
      // We self-attached the guest's debugger (it started detached).
      expect(guestDbg.attach).toHaveBeenCalledWith('1.3')
      // The teardown was registered against the guest's connection, not as a raw
      // 'destroyed' listener consumed by the feature directly.
      expect(connections.get(guest.id)).toBeDefined()

      // Destroy the guest → the connection registry disposes the owned cleanup
      // (onDestroyed), which removes it from selfAttached.
      guest.__destroy()
      await vi.advanceTimersByTimeAsync(5)

      stop()
      // Connection-routed onDestroyed already dropped this wc from selfAttached,
      // so stop() must NOT detach the (now destroyed) session.
      expect(guestDbg.detach).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

// ── guest priming (enable-domain ordering) ──────────────────────────────────────

// Names of the priming enable commands as they reach the guest debugger.
function enableSendOrder(guestDbg: ReturnType<typeof fakeDebugger>): string[] {
  return (guestDbg.sendCommand as ReturnType<typeof vi.fn>).mock.calls
    .map((c) => c[0] as string)
    .filter((m) => m === 'DOM.enable' || m === 'CSS.enable' || m === 'Overlay.enable')
}

describe('installElementsForward — guest priming ordering', () => {
  // Chromium rejects `Overlay.enable` with -32000 "DOM should be enabled first"
  // when it arrives before `DOM.enable` has completed. Priming MUST therefore let
  // `DOM.enable` settle before sending `Overlay.enable`, not fire them
  // concurrently. With a deferred `DOM.enable`, `Overlay.enable` must not appear
  // on the guest until that deferral resolves.
  it('does not send Overlay.enable to the guest until DOM.enable has resolved', async () => {
    vi.useFakeTimers()
    try {
      let resolveDomEnable!: (v: unknown) => void
      const guestDbg = fakeDebugger({
        attached: true,
        sendCommand: vi.fn((method: string) => {
          if (method === 'DOM.enable') {
            return new Promise((res) => { resolveDomEnable = res })
          }
          return Promise.resolve({})
        }),
      })
      const guest = fakeWc({ debugger: guestDbg })
      const devtoolsWc = devtoolsWcDrainingOnce([])
      const bridge = fakeBridge(() => guest)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stop = installElementsForward({ devtoolsWc: devtoolsWc as any, bridge: bridge as any })

      // Priming runs as the guest is wired. DOM.enable is in flight (deferred).
      await vi.advanceTimersByTimeAsync(400)
      expect(enableSendOrder(guestDbg)).toContain('DOM.enable')
      // Overlay.enable must NOT have been sent while DOM.enable is still pending.
      expect(enableSendOrder(guestDbg)).not.toContain('Overlay.enable')

      // DOM.enable completes → Overlay.enable is now allowed to go out.
      resolveDomEnable({})
      await vi.advanceTimersByTimeAsync(50)

      const order = enableSendOrder(guestDbg)
      expect(order).toContain('Overlay.enable')
      // DOM.enable precedes Overlay.enable in the send order.
      expect(order.indexOf('DOM.enable')).toBeLessThan(order.indexOf('Overlay.enable'))
      stop()
    } finally {
      vi.useRealTimers()
    }
  })

  // The priming sequence is anchored to the guest it began on. If the active
  // render guest switches mid-enable (a page swap between DOM.enable being sent
  // and resolving), the now-stale original guest must NOT receive Overlay.enable:
  // its DOM tree is no longer what the front-end is looking at, and re-enabling
  // its Overlay would paint into an abandoned tree.
  it('does not send Overlay.enable to the original guest if the active guest switched before DOM.enable resolved', async () => {
    vi.useFakeTimers()
    try {
      let resolveDomEnable!: (v: unknown) => void
      // Guest A: DOM.enable is deferred so we can flip the active guest mid-enable.
      const aDbg = fakeDebugger({
        attached: true,
        sendCommand: vi.fn((method: string) => {
          if (method === 'DOM.enable') {
            return new Promise((res) => { resolveDomEnable = res })
          }
          return Promise.resolve({})
        }),
      })
      const guestA = fakeWc({ debugger: aDbg })
      const bDbg = fakeDebugger({ attached: true })
      const guestB = fakeWc({ debugger: bDbg })
      const devtoolsWc = devtoolsWcDrainingOnce([])
      const bridge = fakeSwitchableBridge(guestA)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stop = installElementsForward({ devtoolsWc: devtoolsWc as any, bridge: bridge as any })

      // Priming begins on A. DOM.enable is sent and left pending.
      await vi.advanceTimersByTimeAsync(400)
      expect(enableSendOrder(aDbg)).toContain('DOM.enable')
      expect(enableSendOrder(aDbg)).not.toContain('Overlay.enable')

      // Active render guest switches A → B before DOM.enable resolves.
      bridge.setActive(guestB)
      bridge.__emit({ kind: 'activePage', appId: 'a', bridgeId: 'b' })
      await vi.advanceTimersByTimeAsync(5)

      // A's DOM.enable finally resolves — but A is no longer the active guest.
      resolveDomEnable({})
      await vi.advanceTimersByTimeAsync(50)

      // The stale guest A must NEVER get Overlay.enable after the switch.
      expect(enableSendOrder(aDbg)).not.toContain('Overlay.enable')
      stop()
    } finally {
      vi.useRealTimers()
    }
  })

  // All three Elements-tree domains are ultimately enabled on the guest so the
  // panel can read the DOM/CSS and paint the inspect overlay.
  it('enables DOM, CSS, and Overlay on the primed guest', async () => {
    vi.useFakeTimers()
    try {
      const guestDbg = fakeDebugger({ attached: true })
      const guest = fakeWc({ debugger: guestDbg })
      const devtoolsWc = devtoolsWcDrainingOnce([])
      const bridge = fakeBridge(() => guest)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stop = installElementsForward({ devtoolsWc: devtoolsWc as any, bridge: bridge as any })

      await vi.advanceTimersByTimeAsync(400)

      const order = enableSendOrder(guestDbg)
      expect(order).toContain('DOM.enable')
      expect(order).toContain('CSS.enable')
      expect(order).toContain('Overlay.enable')
      stop()
    } finally {
      vi.useRealTimers()
    }
  })

  // Priming is best-effort: a failing enable (here DOM.enable rejects, the exact
  // failure mode Chromium reports for an out-of-order enable) must not surface as
  // a thrown error or a rejected priming, and the disposer must stay callable.
  it('does not throw when a priming enable rejects', async () => {
    vi.useFakeTimers()
    try {
      const guestDbg = fakeDebugger({
        attached: true,
        sendCommand: vi.fn((method: string) =>
          method === 'DOM.enable'
            ? Promise.reject(new Error('DOM should be enabled first'))
            : Promise.resolve({})),
      })
      const guest = fakeWc({ debugger: guestDbg })
      const devtoolsWc = devtoolsWcDrainingOnce([])
      const bridge = fakeBridge(() => guest)

      let stop!: () => void
      expect(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        stop = installElementsForward({ devtoolsWc: devtoolsWc as any, bridge: bridge as any })
      }).not.toThrow()

      // Let the priming sequence run to completion past the rejection.
      await vi.advanceTimersByTimeAsync(400)
      expect(enableSendOrder(guestDbg)).toContain('DOM.enable')
      expect(() => stop()).not.toThrow()
    } finally {
      vi.useRealTimers()
    }
  })
})

// ── Overlay.disable guard (highlight survives Elements-panel state transitions) ──

describe('installElementsForward — Overlay.disable guard', () => {
  // Chrome's Elements front-end emits `Overlay.disable` on some panel state
  // transitions. Forwarding it verbatim returns the guest's Overlay to the
  // non-painting state, after which `Overlay.highlightNode` fails until Overlay is
  // re-enabled. The feature must NOT leave the guest's Overlay disabled: either it
  // never forwards `Overlay.disable` to the guest at all, or it re-enables Overlay
  // (sends `Overlay.enable`) at or after the disable. Either strategy satisfies
  // the requirement; this pins the net effect, not the mechanism.
  it('does not leave the guest Overlay disabled after a forwarded Overlay.disable', async () => {
    vi.useFakeTimers()
    try {
      const guestDbg = fakeDebugger({ attached: true })
      const guest = fakeWc({ debugger: guestDbg })
      const devtoolsWc = devtoolsWcDrainingOnce([
        { id: 21, method: 'Overlay.disable', params: {}, sessionId: null },
      ])
      const bridge = fakeBridge(() => guest)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stop = installElementsForward({ devtoolsWc: devtoolsWc as any, bridge: bridge as any })

      await vi.advanceTimersByTimeAsync(400)

      const sent = (guestDbg.sendCommand as ReturnType<typeof vi.fn>).mock.calls
        .map((c) => c[0] as string)
      const disableIdx = sent.indexOf('Overlay.disable')

      if (disableIdx === -1) {
        // Strategy (i): Overlay.disable is swallowed and never reaches the guest.
        expect(sent).not.toContain('Overlay.disable')
      } else {
        // Strategy (ii): Overlay.disable is forwarded, but Overlay is re-enabled
        // at or after it, so the guest is not left in the disabled state.
        const reEnableIdx = sent.indexOf('Overlay.enable', disableIdx)
        expect(reEnableIdx).toBeGreaterThanOrEqual(disableIdx)
      }
      stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
