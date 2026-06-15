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
import { describe, it, expect } from 'vitest'
import type { WebContents } from 'electron'

import { createConnectionRegistry } from '@dimina-kit/electron-deck/main'
import { createSafeAreaController } from './index.js'

type AnyFn = (...args: unknown[]) => unknown

/** Minimal emitter-backed WebContents fake (id/once/emit/isDestroyed + the
 *  debugger surface safe-area touches). `sink` captures every `sendCommand`. */
function makeWc(
  id: number,
  sink?: Array<{ method: string; params: unknown }>,
): WebContents & { emit: (e: string) => void } {
  const listeners: Record<string, Set<AnyFn>> = {}
  let destroyed = false
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
      attach: () => {},
      detach: () => {},
      sendCommand: (method: string, params: unknown) => {
        sink?.push({ method, params })
        return Promise.resolve({})
      },
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

    controller.applyToGuest(wc, null, false)

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
    controller.applyToGuest(makeWc(1, sink), DEVICE, false)
    const insets = lastInsets(sink)
    expect(insets.top).toBe(47)
    expect(insets.bottom).toBe(34)
    expect(insets.bottomMax).toBe(34)
  })

  it('a tab page gets bottom 0 (the shell tabBar fills the safe area)', () => {
    const sink: Array<{ method: string; params: unknown }> = []
    const controller = createSafeAreaController()
    controller.applyToGuest(makeWc(2, sink), DEVICE, true)
    const insets = lastInsets(sink)
    expect(insets.top).toBe(47)
    expect(insets.bottom).toBe(0)
    expect(insets.bottomMax).toBe(0)
  })

  it('reapplyAll keeps each guest its attached page type', () => {
    const sinkTab: Array<{ method: string; params: unknown }> = []
    const sinkPage: Array<{ method: string; params: unknown }> = []
    const controller = createSafeAreaController()
    controller.applyToGuest(makeWc(3, sinkTab), DEVICE, true)
    controller.applyToGuest(makeWc(4, sinkPage), DEVICE, false)
    sinkTab.length = 0
    sinkPage.length = 0
    controller.reapplyAll(DEVICE)
    expect(lastInsets(sinkTab).bottom).toBe(0)
    expect(lastInsets(sinkPage).bottom).toBe(34)
  })
})
