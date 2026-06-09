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
 *  debugger surface safe-area touches). */
function makeWc(id: number): WebContents & { emit: (e: string) => void } {
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
      sendCommand: () => Promise.resolve({}),
    },
  }
  return wc as unknown as WebContents & { emit: (e: string) => void }
}

describe('createSafeAreaController teardown routing', () => {
  it('routes guest prune through the connection registry; destroy cleans both', () => {
    const connections = createConnectionRegistry()
    const controller = createSafeAreaController({ connections })
    const wc = makeWc(7)

    controller.applyToGuest(wc, null)

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
