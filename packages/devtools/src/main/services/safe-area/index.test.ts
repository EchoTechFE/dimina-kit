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

/** A notched phone held upright — the case where page and device orientation can disagree. */
const NOTCHED_PORTRAIT = {
  statusBarHeight: 44,
  notchType: 'notch',
  deviceOrientation: 'portrait',
  safeAreaInsets: { top: 44, right: 0, bottom: 34, left: 0 },
} as never

/** A page whose orientation main has not heard about yet. */
const page = (bridgeId: string | null, isTabPage = false) => ({ bridgeId, isTabPage })

describe('createSafeAreaController teardown routing', () => {
  it('routes guest prune through the connection registry; destroy cleans both', () => {
    const connections = createConnectionRegistry()
    const controller = createSafeAreaController({ connections })
    const wc = makeWc(7)

    controller.applyToGuest(wc, null, page(null))

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
    controller.applyToGuest(makeWc(1, sink), DEVICE, page('bridge_1'))
    const insets = lastInsets(sink)
    expect(insets.top).toBe(47)
    expect(insets.bottom).toBe(34)
    expect(insets.bottomMax).toBe(34)
  })

  it('a tab page gets bottom 0 (the shell tabBar fills the safe area)', () => {
    const sink: Array<{ method: string; params: unknown }> = []
    const controller = createSafeAreaController()
    controller.applyToGuest(makeWc(2, sink), DEVICE, page('bridge_2', true))
    const insets = lastInsets(sink)
    expect(insets.top).toBe(47)
    expect(insets.bottom).toBe(0)
    expect(insets.bottomMax).toBe(0)
  })

  it('landscape moves the notch onto both sides and frees the top', () => {
    // A notched phone rotated: WeChat's own landscape safe area for this class of screen is top 0 / sides = the notch depth / a thinner home indicator.
    const landscapeDevice = {
      statusBarHeight: 44,
      notchType: 'notch',
      deviceOrientation: 'landscape',
      safeAreaInsets: { top: 44, right: 0, bottom: 34, left: 0 },
    } as never
    const sink: Array<{ method: string; params: unknown }> = []
    const controller = createSafeAreaController()
    controller.applyToGuest(makeWc(11, sink), landscapeDevice, page('bridge_11'))
    const call = [...sink].reverse().find((c) => c.method === 'Emulation.setSafeAreaInsetsOverride')
    expect(call?.params).toMatchObject({
      insets: { top: 0, left: 44, leftMax: 44, right: 44, rightMax: 44, bottom: 21, bottomMax: 21 },
    })
  })

  it('reapplyAll keeps each guest its attached page type', () => {
    const sinkTab: Array<{ method: string; params: unknown }> = []
    const sinkPage: Array<{ method: string; params: unknown }> = []
    const controller = createSafeAreaController()
    controller.applyToGuest(makeWc(3, sinkTab), DEVICE, page('bridge_3', true))
    controller.applyToGuest(makeWc(4, sinkPage), DEVICE, page('bridge_4'))
    sinkTab.length = 0
    sinkPage.length = 0
    controller.reapplyAll(DEVICE)
    expect(lastInsets(sinkTab).bottom).toBe(0)
    expect(lastInsets(sinkPage).bottom).toBe(34)
  })

  // Guards that `applyToGuest` subscribes to `lease.onDetach`: without it, an external detach would leave `reapplyAll`/`override` calling `.send()` on a dead lease instead of reacquiring — env overrides would silently stop recovering for a still-live guest.
  it('reacquires and keeps applying insets after the debugger session is externally detached', () => {
    const sink: Array<{ method: string; params: unknown }> = []
    const wc = makeWc(5, sink)
    const controller = createSafeAreaController()
    controller.applyToGuest(wc, DEVICE, page('bridge_5'))
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

/**
 * The insets a guest receives must describe the orientation ITS OWN page is showing, which is what `wx.getSystemInfoSync().safeArea` reports for that page.
 * A page-level `pageOrientation` makes the two disagree with the device: a landscape page on an upright phone reads sides of 44 in JS, so CSS `env(safe-area-inset-left/right)` has to say 44 too.
 */
describe('createSafeAreaController per-page orientation', () => {
  function lastInsets(sink: Array<{ method: string; params: unknown }>) {
    const call = [...sink].reverse().find((c) => c.method === 'Emulation.setSafeAreaInsetsOverride')
    return (call?.params as { insets: Record<string, number> } | undefined)?.insets
  }

  it('a page pinned to landscape on an upright device gets landscape insets', () => {
    const sink: Array<{ method: string; params: unknown }> = []
    const controller = createSafeAreaController()
    controller.applyToGuest(makeWc(20, sink), NOTCHED_PORTRAIT, page('bridge_detail'))
    expect(lastInsets(sink)).toMatchObject({ top: 44, left: 0, right: 0, bottom: 34 })

    sink.length = 0
    controller.recordPageOrientation('bridge_detail', 'landscape', NOTCHED_PORTRAIT)
    expect(lastInsets(sink)).toMatchObject({
      top: 0, left: 44, leftMax: 44, right: 44, rightMax: 44, bottom: 21, bottomMax: 21,
    })
  })

  it('an orientation reported before the guest attaches is applied on attach', () => {
    const sink: Array<{ method: string; params: unknown }> = []
    const controller = createSafeAreaController()
    // Routing publishes the incoming page's resize before React mounts its
    // <webview>, so main can know the orientation before the guest exists.
    controller.recordPageOrientation('bridge_early', 'landscape', NOTCHED_PORTRAIT)
    controller.applyToGuest(makeWc(21, sink), NOTCHED_PORTRAIT, page('bridge_early'))
    expect(lastInsets(sink)).toMatchObject({ top: 0, left: 44, right: 44, bottom: 21 })
  })

  it('only the named page is re-pushed; a hidden tab-substack guest keeps its own orientation', () => {
    const sinkTop: Array<{ method: string; params: unknown }> = []
    const sinkHidden: Array<{ method: string; params: unknown }> = []
    const controller = createSafeAreaController()
    controller.applyToGuest(makeWc(22, sinkTop), NOTCHED_PORTRAIT, page('bridge_top', true))
    controller.applyToGuest(makeWc(23, sinkHidden), NOTCHED_PORTRAIT, page('bridge_hidden', true))
    sinkTop.length = 0
    sinkHidden.length = 0

    controller.recordPageOrientation('bridge_top', 'landscape', NOTCHED_PORTRAIT)

    expect(lastInsets(sinkTop)).toMatchObject({ top: 0, left: 44, right: 44 })
    expect(sinkHidden, 'the hidden guest must not be touched at all').toHaveLength(0)

    // A later device change must not spread the top page's orientation either.
    controller.reapplyAll(NOTCHED_PORTRAIT)
    expect(lastInsets(sinkTop)).toMatchObject({ top: 0, left: 44, right: 44 })
    expect(lastInsets(sinkHidden)).toMatchObject({ top: 44, left: 0, right: 0 })
  })

  it('a guest whose page never reported an orientation follows the device', () => {
    const sink: Array<{ method: string; params: unknown }> = []
    const landscapeDevice = { ...(NOTCHED_PORTRAIT as object), deviceOrientation: 'landscape' } as never
    const controller = createSafeAreaController()
    controller.applyToGuest(makeWc(24, sink), landscapeDevice, page('bridge_silent'))
    expect(lastInsets(sink)).toMatchObject({ top: 0, left: 44, right: 44, bottom: 21 })
  })
})

/**
 * The orientation ledger belongs to the PAGE, not to whichever WebContents is currently rendering it.
 * A page keeps its bridgeId across a render-guest swap (bridge-router's `ensureRenderBound` rebinds the same page to a new sender), and routing can publish a resize for a page whose `<webview>` never mounts — so guest destruction can neither be the thing that drops an entry nor the only thing that can.
 */
describe('createSafeAreaController orientation ledger lifetime', () => {
  function lastInsets(sink: Array<{ method: string; params: unknown }>) {
    const call = [...sink].reverse().find((c) => c.method === 'Emulation.setSafeAreaInsetsOverride')
    return (call?.params as { insets: Record<string, number> } | undefined)?.insets
  }

  it('keeps the page orientation when its render guest is replaced', () => {
    const sinkOld: Array<{ method: string; params: unknown }> = []
    const sinkNew: Array<{ method: string; params: unknown }> = []
    const controller = createSafeAreaController()
    const oldGuest = makeWc(30, sinkOld)
    controller.applyToGuest(oldGuest, NOTCHED_PORTRAIT, page('bridge_swap'))
    controller.recordPageOrientation('bridge_swap', 'landscape', NOTCHED_PORTRAIT)

    // The page reloads its render host: same bridgeId, a new WebContents.
    const newGuest = makeWc(31, sinkNew)
    controller.applyToGuest(newGuest, NOTCHED_PORTRAIT, page('bridge_swap'))
    oldGuest.emit('destroyed')
    sinkNew.length = 0

    controller.reapplyAll(NOTCHED_PORTRAIT)

    expect(
      lastInsets(sinkNew),
      'the surviving guest must keep the orientation its page reported',
    ).toMatchObject({ top: 0, left: 44, right: 44 })
  })

  it('forgets a page whose guest never attached, so an interrupted route leaks nothing', () => {
    const sink: Array<{ method: string; params: unknown }> = []
    const controller = createSafeAreaController()
    // Routing published the incoming page's resize, then the route failed and React never mounted a `<webview>` for it: no guest will ever carry it.
    controller.recordPageOrientation('bridge_ghost', 'landscape', NOTCHED_PORTRAIT)

    controller.forgetPageOrientation('bridge_ghost')

    // bridgeIds are never reused, but the entry must be gone all the same: a later guest claiming it would otherwise inherit a dead page's rotation.
    controller.applyToGuest(makeWc(32, sink), NOTCHED_PORTRAIT, page('bridge_ghost'))
    expect(lastInsets(sink)).toMatchObject({ top: 44, left: 0, right: 0 })
  })

  it('forgetting one page leaves every other page\'s orientation intact', () => {
    const sinkKept: Array<{ method: string; params: unknown }> = []
    const controller = createSafeAreaController()
    controller.applyToGuest(makeWc(33, sinkKept), NOTCHED_PORTRAIT, page('bridge_kept'))
    controller.recordPageOrientation('bridge_kept', 'landscape', NOTCHED_PORTRAIT)
    controller.recordPageOrientation('bridge_gone', 'landscape', NOTCHED_PORTRAIT)
    sinkKept.length = 0

    controller.forgetPageOrientation('bridge_gone')
    controller.reapplyAll(NOTCHED_PORTRAIT)

    expect(lastInsets(sinkKept)).toMatchObject({ top: 0, left: 44, right: 44 })
  })
})

/**
 * Every ledger this controller owns is per page or per guest, so a churn cycle that opens and closes the same number of each must leave every count exactly where it started.
 * A count that only "looks small" hides the leak class these ledgers are prone to: an entry whose owner has an end the ledger never hears about.
 */
describe('createSafeAreaController ledger returns to baseline after churn', () => {
  it('page open/close churn leaves no orientation entry and no guest behind', () => {
    const registry = createConnectionRegistry()
    const controller = createSafeAreaController({ connections: registry })
    const baseline = controller.census()
    expect(baseline).toEqual({ guests: 0, leases: 0, pageOrientations: 0 })

    for (let round = 0; round < 5; round++) {
      const bridgeId = `bridge_churn_${round}`
      const wc = makeWc(200 + round)
      controller.applyToGuest(wc, NOTCHED_PORTRAIT, page(bridgeId))
      controller.recordPageOrientation(bridgeId, 'landscape', NOTCHED_PORTRAIT)
      // The page ends, then its guest is destroyed — the real order for a navigateBack: main closes the page, React unmounts the `<webview>`.
      controller.forgetPageOrientation(bridgeId)
      wc.emit('destroyed')
    }

    expect(controller.census(), 'five open/close rounds must leave nothing tracked').toEqual(baseline)
  })

  it('a page whose guest is swapped several times still ends with one forget', () => {
    const controller = createSafeAreaController()
    const baseline = controller.census()

    controller.recordPageOrientation('bridge_long', 'landscape', NOTCHED_PORTRAIT)
    for (let round = 0; round < 3; round++) {
      const wc = makeWc(300 + round)
      controller.applyToGuest(wc, NOTCHED_PORTRAIT, page('bridge_long'))
      wc.emit('destroyed')
      expect(
        controller.census().pageOrientations,
        'a guest swap must not end the page it was rendering',
      ).toBe(1)
    }
    controller.forgetPageOrientation('bridge_long')

    expect(controller.census()).toEqual(baseline)
  })
})

describe('createSafeAreaController broker ownership', () => {
  it('disposes a private (non-injected) broker on dispose(), detaching self-attached sessions', () => {
    const wc = makeWc(6)
    const controller = createSafeAreaController() // no broker injected -> owns a private one
    controller.applyToGuest(wc, null, page(null))
    expect(wc.debugger.attach).toHaveBeenCalled()

    controller.dispose()

    expect(wc.debugger.detach).toHaveBeenCalledTimes(1)
  })

  it('does NOT dispose an injected (shared) broker on dispose() — other consumers may still need it', () => {
    const broker = createCdpSessionBroker()
    const wc = makeWc(7)
    const controller = createSafeAreaController({ broker })
    controller.applyToGuest(wc, null, page(null))
    expect(wc.debugger.attach).toHaveBeenCalled()

    controller.dispose()

    // The shared broker's session must survive this controller's own dispose.
    expect(wc.debugger.detach).not.toHaveBeenCalled()
  })
})
