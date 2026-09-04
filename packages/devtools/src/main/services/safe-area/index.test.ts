/**
 * safe-area controller — teardown routing.
 *
 * Pins that when a `ConnectionRegistry` is supplied, the per-guest prune of the
 * `attached` set is registered through `connection.own(...)` (the connection
 * layer's deterministic teardown) instead of a bespoke `wc.once('destroyed')`.
 * On hard-destroy the registry fires the owned disposer, so the `attached`
 * entry is pruned AND the registry de-registers the connection (no leak).
 *
 * The fallback path (no `connections`) is covered by the existing
 * device/safe-area behaviour; here we focus on the connection-routed teardown.
 */
import { describe, it, expect, vi } from 'vitest'
import type { WebContents } from 'electron'

import { createConnectionRegistry } from '@dimina-kit/electron-deck/main'
import { createSafeAreaController } from './index.js'
import { createCdpSessionBroker } from '../cdp-session/index.js'

type AnyFn = (...args: unknown[]) => unknown

/** Minimal emitter-backed WebContents fake (id/once/emit/isDestroyed + the
 *  debugger surface safe-area touches). `sink` captures every `sendCommand`. */
// The broker (see cdp-session/index.ts, which safe-area now goes through
// instead of touching wc.debugger directly) reads isAttached()/on()/
// removeListener() in addition to attach()/detach()/sendCommand() — this fake
// grows the same surface. Existing assertions (connection-routed teardown,
// per-page-type bottom inset) are unchanged; only the mock's surface area
// needed to widen to match the broker's dependency.
function makeWc(
  id: number,
  sink?: Array<{ method: string; params: unknown }>,
): WebContents & { emit: (e: string) => void } {
  const listeners: Record<string, Set<AnyFn>> = {}
  const dbgListeners: Record<string, Set<AnyFn>> = {}
  let destroyed = false
  let dbgAttached = false
  const wc = {
    id,
    once(event: string, fn: AnyFn) {
      const wrap: AnyFn = (...a: unknown[]) => {
        listeners[event]?.delete(wrap)
        return fn(...a)
      }
      ;(listeners[event] ??= new Set()).add(wrap)
      return wc
    },
    emit(event: string, ...a: unknown[]) {
      for (const fn of [...(listeners[event] ?? [])]) fn(...a)
      if (event === 'destroyed') destroyed = true
    },
    isDestroyed: () => destroyed,
    debugger: {
      isAttached: () => dbgAttached,
      attach: vi.fn(() => { dbgAttached = true }),
      detach: vi.fn(() => {
        if (!dbgAttached) return
        dbgAttached = false
        for (const fn of [...(dbgListeners.detach ?? [])]) fn()
      }),
      sendCommand: (method: string, params: unknown) => {
        sink?.push({ method, params })
        return Promise.resolve({})
      },
      on: (event: string, fn: AnyFn) => { (dbgListeners[event] ??= new Set()).add(fn) },
      removeListener: (event: string, fn: AnyFn) => { dbgListeners[event]?.delete(fn) },
    },
  }
  return wc as unknown as WebContents & { emit: (e: string) => void }
}

const DEVICE = { safeAreaInsets: { top: 47, right: 0, bottom: 34, left: 0 } } as never

describe('createSafeAreaController teardown routing', () => {
  it('routes guest prune through the connection registry; destroy cleans both', () => {
    const connections = createConnectionRegistry()
    const controller = createSafeAreaController({ connections })
    const wc = makeWc(7)

    controller.applyToGuest(wc, null, { isTabPage: false, isCustomNav: false })

    // The connection was acquired for this guest.
    expect(connections.get(wc.id), 'guest connection must be live before destroy').toBeDefined()
    // Re-applying is a no-op attach (already tracked) — sanity that it stays attached.
    expect(connections.get(wc.id)!.alive).toBe(true)

    // Hard destroy → connection fires its owned disposer (prunes `attached`) and
    // de-registers itself.
    wc.emit('destroyed')

    // attached entry gone: a fresh applyToGuest would have to re-attach. We
    // assert via the registry instead, since `attached` is private.
    expect(
      connections.get(wc.id),
      'registry must de-register the connection after destroy (no leak)',
    ).toBeUndefined()

    // dispose() must not throw and must not touch the destroyed guest.
    expect(() => controller.dispose()).not.toThrow()
  })
})

describe('createSafeAreaController per-page-type bottom inset', () => {
  function lastInsets(sink: Array<{ method: string; params: unknown }>) {
    const call = [...sink].reverse().find((c) => c.method === 'Emulation.setSafeAreaInsetsOverride')
    return (call?.params as { insets: { top: number; bottom: number; bottomMax: number } }).insets
  }

  it('a non-tab page gets the real bottom inset (page opts in via env)', () => {
    const sink: Array<{ method: string; params: unknown }> = []
    const controller = createSafeAreaController()
    controller.applyToGuest(makeWc(1, sink), DEVICE, { isTabPage: false, isCustomNav: true })
    const insets = lastInsets(sink)
    expect(insets.top).toBe(47)
    expect(insets.bottom).toBe(34)
    expect(insets.bottomMax).toBe(34)
  })

  it('a tab page gets bottom 0 (the shell tabBar fills the safe area)', () => {
    const sink: Array<{ method: string; params: unknown }> = []
    const controller = createSafeAreaController()
    controller.applyToGuest(makeWc(2, sink), DEVICE, { isTabPage: true, isCustomNav: true })
    const insets = lastInsets(sink)
    expect(insets.top).toBe(47)
    expect(insets.bottom).toBe(0)
    expect(insets.bottomMax).toBe(0)
  })

  it('reapplyAll keeps each guest its attached page type', () => {
    const sinkTab: Array<{ method: string; params: unknown }> = []
    const sinkPage: Array<{ method: string; params: unknown }> = []
    const controller = createSafeAreaController()
    controller.applyToGuest(makeWc(3, sinkTab), DEVICE, { isTabPage: true, isCustomNav: true })
    controller.applyToGuest(makeWc(4, sinkPage), DEVICE, { isTabPage: false, isCustomNav: true })
    sinkTab.length = 0
    sinkPage.length = 0
    controller.reapplyAll(DEVICE)
    expect(lastInsets(sinkTab).bottom).toBe(0)
    expect(lastInsets(sinkPage).bottom).toBe(34)
  })

  // A codex adversarial review caught this: `applyToGuest` never subscribed to
  // `lease.onDetach`, so after an external detach `reapplyAll`/`override` kept
  // calling `.send()` on a dead lease instead of reacquiring — env overrides
  // would silently stop recovering for a still-live guest.
  it('reacquires and keeps applying insets after the debugger session is externally detached', () => {
    const sink: Array<{ method: string; params: unknown }> = []
    const wc = makeWc(5, sink)
    const controller = createSafeAreaController()
    controller.applyToGuest(wc, DEVICE, { isTabPage: false, isCustomNav: true })
    expect(lastInsets(sink).bottom).toBe(34)

    // Something outside safe-area detaches the shared debugger session
    // (another owner releasing it, or a real Chrome DevTools window).
    ;(wc.debugger.detach as unknown as () => void)()
    sink.length = 0

    // reapplyAll must reacquire (not silently no-op on a stale lease) and
    // keep applying the SAME page-type policy this guest attached with.
    controller.reapplyAll(DEVICE)
    expect(sink.length).toBeGreaterThan(0)
    expect(lastInsets(sink).bottom).toBe(34)
  })
})

// device.safeAreaInsets carries per-edge insets straight from the
// @devicekit/devices table (e.g. iPhone 15 landscape: left/right 59 from the
// Dynamic Island rotating into a side notch). `guestInsets` must forward
// right/left instead of hardcoding 0.
const LANDSCAPE_DEVICE = { safeAreaInsets: { top: 0, right: 59, bottom: 21, left: 59 } } as never

describe('createSafeAreaController per-edge left/right insets', () => {
  function lastFullInsets(sink: Array<{ method: string; params: unknown }>) {
    const call = [...sink].reverse().find((c) => c.method === 'Emulation.setSafeAreaInsetsOverride')
    return (call?.params as {
      insets: { top: number; right: number; rightMax: number; bottom: number; left: number; leftMax: number }
    }).insets
  }

  it('forwards the device safeAreaInsets right/left into the CDP override', () => {
    const sink: Array<{ method: string; params: unknown }> = []
    const controller = createSafeAreaController()
    controller.applyToGuest(makeWc(8, sink), LANDSCAPE_DEVICE, { isTabPage: false, isCustomNav: false })
    const insets = lastFullInsets(sink)
    expect(insets.right).toBe(59)
    expect(insets.rightMax).toBe(59)
    expect(insets.left).toBe(59)
    expect(insets.leftMax).toBe(59)
  })

  it('a tab page still gets bottom 0 but keeps the real left/right insets', () => {
    const sink: Array<{ method: string; params: unknown }> = []
    const controller = createSafeAreaController()
    controller.applyToGuest(makeWc(9, sink), LANDSCAPE_DEVICE, { isTabPage: true, isCustomNav: false })
    const insets = lastFullInsets(sink)
    expect(insets.bottom).toBe(0)
    expect(insets.left).toBe(59)
    expect(insets.right).toBe(59)
  })
})

describe('createSafeAreaController broker ownership', () => {
  it('disposes a private (non-injected) broker on dispose(), detaching self-attached sessions', () => {
    const wc = makeWc(6)
    const controller = createSafeAreaController() // no broker injected -> owns a private one
    controller.applyToGuest(wc, null, { isTabPage: false, isCustomNav: false })
    expect(wc.debugger.attach).toHaveBeenCalled()

    controller.dispose()

    expect(wc.debugger.detach).toHaveBeenCalledTimes(1)
  })

  it('does NOT dispose an injected (shared) broker on dispose() — other consumers may still need it', () => {
    const broker = createCdpSessionBroker()
    const wc = makeWc(7)
    const controller = createSafeAreaController({ broker })
    controller.applyToGuest(wc, null, { isTabPage: false, isCustomNav: false })
    expect(wc.debugger.attach).toHaveBeenCalled()

    controller.dispose()

    // The shared broker's session must survive this controller's own dispose.
    expect(wc.debugger.detach).not.toHaveBeenCalled()
  })
})

// A default-navigation-bar page's guest already starts BELOW the shell-drawn
// navigation bar, which itself covers the notch — the same layout dimina's
// native containers produce. Surfacing the device top inset there would push
// the page content down a second time. Only a custom-nav (full-bleed) page
// borders the unsafe top zone and needs the real inset.
describe('createSafeAreaController per-page navigation-style top inset', () => {
  function lastInsets(sink: Array<{ method: string; params: unknown }>) {
    const call = [...sink].reverse().find((c) => c.method === 'Emulation.setSafeAreaInsetsOverride')
    return (call?.params as {
      insets: { top: number; topMax: number; bottom: number; bottomMax: number }
    }).insets
  }

  it('a default navigation-bar page gets top 0 (the shell nav bar already clears the notch)', () => {
    const sink: Array<{ method: string; params: unknown }> = []
    const controller = createSafeAreaController()
    controller.applyToGuest(makeWc(10, sink), DEVICE, { isTabPage: false, isCustomNav: false })
    const insets = lastInsets(sink)
    expect(insets.top).toBe(0)
    expect(insets.topMax).toBe(0)
  })

  it('a custom navigation-bar page gets the real device top inset', () => {
    const sink: Array<{ method: string; params: unknown }> = []
    const controller = createSafeAreaController()
    controller.applyToGuest(makeWc(11, sink), DEVICE, { isTabPage: false, isCustomNav: true })
    const insets = lastInsets(sink)
    expect(insets.top).toBe(47)
    expect(insets.topMax).toBe(47)
  })

  it('the bottom inset stays page-type driven regardless of navigation style', () => {
    const defaultNavTab: Array<{ method: string; params: unknown }> = []
    const defaultNavPage: Array<{ method: string; params: unknown }> = []
    const customNavTab: Array<{ method: string; params: unknown }> = []
    const customNavPage: Array<{ method: string; params: unknown }> = []
    const controller = createSafeAreaController()
    controller.applyToGuest(makeWc(12, defaultNavTab), DEVICE, { isTabPage: true, isCustomNav: false })
    controller.applyToGuest(makeWc(13, defaultNavPage), DEVICE, { isTabPage: false, isCustomNav: false })
    controller.applyToGuest(makeWc(14, customNavTab), DEVICE, { isTabPage: true, isCustomNav: true })
    controller.applyToGuest(makeWc(15, customNavPage), DEVICE, { isTabPage: false, isCustomNav: true })

    expect(lastInsets(defaultNavTab).bottom).toBe(0)
    expect(lastInsets(defaultNavPage).bottom).toBe(34)
    expect(lastInsets(customNavTab).bottom).toBe(0)
    expect(lastInsets(customNavPage).bottom).toBe(34)
  })

  it('reapplyAll after a device change keeps each guest its navigation style', () => {
    const defaultNav: Array<{ method: string; params: unknown }> = []
    const customNav: Array<{ method: string; params: unknown }> = []
    const controller = createSafeAreaController()
    controller.applyToGuest(makeWc(16, defaultNav), DEVICE, { isTabPage: false, isCustomNav: false })
    controller.applyToGuest(makeWc(17, customNav), DEVICE, { isTabPage: false, isCustomNav: true })
    defaultNav.length = 0
    customNav.length = 0

    const NEXT_DEVICE = { safeAreaInsets: { top: 59, right: 0, bottom: 34, left: 0 } } as never
    controller.reapplyAll(NEXT_DEVICE)

    expect(lastInsets(defaultNav).top).toBe(0)
    expect(lastInsets(customNav).top).toBe(59)
  })
})
