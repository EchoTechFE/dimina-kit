import { describe, expect, it } from 'vitest'
import type { WebContents } from 'electron'
import { createWindowContextRouter, type RoutableWindowContext } from './context-router.js'

/** Minimal stand-in: the router only ever reads `sender` through the predicates. */
function wc(id: number): WebContents {
  return { id } as unknown as WebContents
}

/** Same fixture shape as context-router.test.ts: owns one id, accepts a shared trusted set too. */
function makeContext(ownId: number, trusted: Set<number>): RoutableWindowContext {
  const ownsSender = (sender: WebContents) => sender.id === ownId
  return {
    ownsSender,
    senderPolicy: (sender: WebContents) => ownsSender(sender) || trusted.has(sender.id),
  }
}

describe('resolve() is a pure query: only setActive() and unregister move "active"', () => {
  it('resolving a sender another window owns does not pull "active" away from the focused window', () => {
    const router = createWindowContextRouter()
    const a = makeContext(1, new Set())
    const b = makeContext(2, new Set())
    router.register(a)
    router.register(b)
    router.setActive(a)

    expect(router.resolve(wc(2))).toBe(b)
    expect(router.active(), 'looking up B\'s own sender must not make B the active window').toBe(a)
  })

  it('an accepted-but-unowned sender keeps resolving to the focused window, even after the unfocused window resolved a sender of its own', () => {
    const trusted = new Set<number>([50])
    const router = createWindowContextRouter()
    const a = makeContext(1, trusted)
    const b = makeContext(2, trusted)
    router.register(a)
    router.register(b)
    router.setActive(a)

    // B handles one of its own IPC calls first.
    expect(router.resolve(wc(2))).toBe(b)

    expect(
      router.resolve(wc(50)),
      'an app-wide sender no window owns must still be answered by the focused window',
    ).toBe(a)
  })

  it('falls back to the next registrant when the focused window unregisters, unaffected by prior resolves', () => {
    const router = createWindowContextRouter()
    const a = makeContext(1, new Set())
    const b = makeContext(2, new Set())
    const c = makeContext(3, new Set())
    const registrationA = router.register(a)
    router.register(b)
    router.register(c)
    router.setActive(a)
    router.resolve(wc(2))

    registrationA.dispose()
    expect(router.active()).toBe(b)
  })
})
