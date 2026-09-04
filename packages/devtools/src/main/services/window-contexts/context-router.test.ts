import { describe, expect, it } from 'vitest'
import type { WebContents } from 'electron'
import { createWindowContextRouter, type RoutableWindowContext } from './context-router.js'

/** Minimal stand-in: the router only ever reads `sender` through the predicates. */
function wc(id: number): WebContents {
  return { id } as unknown as WebContents
}

/**
 * A window context as the router sees it: it owns its own renderer, and its
 * policy additionally accepts every id in the app-wide trusted-window map —
 * the shape that makes a single-pass scan ambiguous.
 */
function makeContext(ownId: number, trusted: Set<number>): RoutableWindowContext {
  const ownsSender = (sender: WebContents) => sender.id === ownId
  return {
    ownsSender,
    senderPolicy: (sender: WebContents) => ownsSender(sender) || trusted.has(sender.id),
  }
}

describe('window context router', () => {
  it('routes each window renderer to its own context', () => {
    const trusted = new Set<number>()
    const router = createWindowContextRouter()
    const first = makeContext(1, trusted)
    const second = makeContext(2, trusted)
    router.register(first)
    router.register(second)

    expect(router.resolve(wc(1))).toBe(first)
    expect(router.resolve(wc(2))).toBe(second)
  })

  it('returns null for a sender no registered context accepts', () => {
    const router = createWindowContextRouter()
    router.register(makeContext(1, new Set()))

    expect(router.resolve(wc(99))).toBeNull()
  })

  it('stops matching a context once it is unregistered', () => {
    const router = createWindowContextRouter()
    const first = makeContext(1, new Set())
    const second = makeContext(2, new Set())
    router.register(first)
    const registration = router.register(second)

    expect(router.resolve(wc(2))).toBe(second)
    registration.dispose()

    expect(router.resolve(wc(2))).toBeNull()
    expect(router.list()).toEqual([first])
  })

  it('hands an app-wide trusted sender to the active context, not the first', () => {
    const trusted = new Set<number>([50])
    const router = createWindowContextRouter()
    const first = makeContext(1, trusted)
    const second = makeContext(2, trusted)
    router.register(first)
    router.register(second)

    // Both policies accept 50; ownership decides who is answering right now.
    router.setActive(second)
    expect(router.resolve(wc(50))).toBe(second)

    router.setActive(first)
    expect(router.resolve(wc(50))).toBe(first)
  })

  it('answers an app-wide sender from the first registrant until a window is marked active', () => {
    const trusted = new Set<number>([50])
    const router = createWindowContextRouter()
    const first = makeContext(1, trusted)
    const second = makeContext(2, trusted)
    router.register(first)
    router.register(second)

    // Nothing focused yet: registration order is the deterministic fallback,
    // and resolving is a pure query that leaves it alone.
    expect(router.active()).toBe(first)
    expect(router.resolve(wc(2))).toBe(second)
    expect(router.active()).toBe(first)
    expect(router.resolve(wc(50))).toBe(first)
  })

  it('falls back to a still-registered context when the active one goes away', () => {
    const router = createWindowContextRouter()
    const first = makeContext(1, new Set())
    const second = makeContext(2, new Set())
    router.register(first)
    const registration = router.register(second)
    router.setActive(second)

    registration.dispose()
    expect(router.active()).toBe(first)
  })

  it('has no active context before anything registers', () => {
    const router = createWindowContextRouter()
    expect(router.active()).toBeNull()
    expect(router.list()).toEqual([])
  })

  it('ignores setActive for a context it does not hold', () => {
    const router = createWindowContextRouter()
    const first = makeContext(1, new Set())
    router.register(first)

    router.setActive(makeContext(2, new Set()))
    expect(router.active()).toBe(first)
  })
})
