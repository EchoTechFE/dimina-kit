/**
 * A session (app session / service host) hangs listeners off several
 * long-lived emitters — the shared simulator webContents, its own service
 * host webContents, ... — over its lifetime. Disposing the session must
 * detach every one of those hooks, or a surviving emitter (the simulator wc
 * in particular, which persists across soft reloads) accumulates listeners
 * forever. `SessionListenerBag` is the single collection each session
 * registers through, so `dispose()` is the one place that has to get
 * detachment right.
 *
 * This is a pure unit test of the bag against a mock emitter that mirrors
 * Node/Electron `EventEmitter`-like `on`/`once`/`removeListener` semantics:
 * `once()` wraps the handler and the wrapper carries a `.listener`
 * back-reference to the original fn, which is what lets
 * `removeListener(event, fn)` find and remove a once-registration by its
 * original function identity. The mock's `removeListener` also throws when
 * the emitter is "destroyed", mirroring calling a method on a destroyed
 * Electron WebContents — so a bag that forgets to check `isDestroyed()`
 * before detaching fails this suite loudly instead of silently.
 */
import { describe, expect, it, vi } from 'vitest'

import { createSessionListenerBag } from './session-listener-bag.js'
import type { BagEmitter } from './session-listener-bag.js'

type Listener = (...args: unknown[]) => void

interface MockEmitter extends BagEmitter {
  listeners: Record<string, Set<Listener>>
  emit(event: string, ...args: unknown[]): void
  destroy(): void
}

function makeMockEmitter(): MockEmitter {
  const listeners: Record<string, Set<Listener>> = {}
  let destroyed = false

  const removeMatching = (event: string, fn: Listener): void => {
    const set = listeners[event]
    if (!set) return
    for (const l of [...set]) {
      if (l === fn || (l as Listener & { listener?: Listener }).listener === fn) set.delete(l)
    }
  }

  const emitter: MockEmitter = {
    listeners,
    on(event: string, fn: Listener) {
      (listeners[event] ??= new Set()).add(fn)
      return emitter
    },
    once(event: string, fn: Listener) {
      const wrap: Listener & { listener?: Listener } = (...args: unknown[]) => {
        listeners[event]?.delete(wrap)
        fn(...args)
      }
      wrap.listener = fn
      ;(listeners[event] ??= new Set()).add(wrap)
      return emitter
    },
    removeListener(event: string, fn: Listener) {
      if (destroyed) throw new Error('emitter destroyed')
      removeMatching(event, fn)
      return emitter
    },
    isDestroyed() {
      return destroyed
    },
    emit(event: string, ...args: unknown[]) {
      for (const fn of [...(listeners[event] ?? [])]) fn(...args)
    },
    destroy() {
      destroyed = true
    },
  }

  return emitter
}

describe('createSessionListenerBag', () => {
  it('attaches an on() listener immediately via emitter.on and fires it on every emit until dispose', () => {
    const bag = createSessionListenerBag()
    const emitter = makeMockEmitter()
    const fn = vi.fn()

    bag.on(emitter, 'tick', fn)
    expect(emitter.listeners.tick?.size ?? 0).toBe(1)

    emitter.emit('tick', 1)
    emitter.emit('tick', 2)

    expect(fn).toHaveBeenCalledTimes(2)
    expect(fn).toHaveBeenNthCalledWith(1, 1)
    expect(fn).toHaveBeenNthCalledWith(2, 2)
  })

  it('attaches a once() listener via emitter.once and fires it at most once', () => {
    const bag = createSessionListenerBag()
    const emitter = makeMockEmitter()
    const fn = vi.fn()

    bag.once(emitter, 'destroyed', fn)
    emitter.emit('destroyed')
    emitter.emit('destroyed')

    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('dispose() detaches on() and once() listeners via emitter.removeListener, matching once through its wrapper', () => {
    const bag = createSessionListenerBag()
    const emitter = makeMockEmitter()
    const onFn = vi.fn()
    const onceFn = vi.fn()

    bag.on(emitter, 'a', onFn)
    bag.once(emitter, 'b', onceFn)
    expect(emitter.listeners.a?.size ?? 0).toBe(1)
    expect(emitter.listeners.b?.size ?? 0).toBe(1)

    bag.dispose()

    expect(emitter.listeners.a?.size ?? 0).toBe(0)
    expect(emitter.listeners.b?.size ?? 0).toBe(0)

    emitter.emit('a')
    emitter.emit('b')
    expect(onFn).not.toHaveBeenCalled()
    expect(onceFn).not.toHaveBeenCalled()
  })

  it('dispose() skips an emitter whose isDestroyed() returns true instead of calling removeListener on it', () => {
    const bag = createSessionListenerBag()
    const emitter = makeMockEmitter()
    const fn = vi.fn()

    bag.on(emitter, 'a', fn)
    emitter.destroy()

    expect(() => bag.dispose()).not.toThrow()
    // Skipped, not detached — the listener is still sitting on the (now
    // destroyed) emitter because removeListener was never called on it.
    expect(emitter.listeners.a?.size ?? 0).toBe(1)
  })

  it('dispose() is idempotent — a second call does not throw or double-remove', () => {
    const bag = createSessionListenerBag()
    const emitter = makeMockEmitter()
    const fn = vi.fn()

    bag.on(emitter, 'a', fn)
    bag.dispose()

    expect(() => bag.dispose()).not.toThrow()
    expect(emitter.listeners.a?.size ?? 0).toBe(0)
  })

  it('tolerates a once() handler that calls bag.dispose() itself, still detaching the bag\'s other listeners', () => {
    const bag = createSessionListenerBag()
    const emitterA = makeMockEmitter()
    const emitterB = makeMockEmitter()
    const otherFn = vi.fn()

    bag.on(emitterB, 'tick', otherFn)
    bag.once(emitterA, 'destroyed', () => {
      bag.dispose()
    })

    expect(() => emitterA.emit('destroyed')).not.toThrow()

    emitterB.emit('tick')
    expect(otherFn).not.toHaveBeenCalled()
  })

  it('does not attach on()/once() registrations made after dispose()', () => {
    const bag = createSessionListenerBag()
    const emitter = makeMockEmitter()
    bag.dispose()

    const onFn = vi.fn()
    const onceFn = vi.fn()
    bag.on(emitter, 'a', onFn)
    bag.once(emitter, 'b', onceFn)

    expect(emitter.listeners.a?.size ?? 0).toBe(0)
    expect(emitter.listeners.b?.size ?? 0).toBe(0)

    emitter.emit('a')
    emitter.emit('b')
    expect(onFn).not.toHaveBeenCalled()
    expect(onceFn).not.toHaveBeenCalled()
  })

  it('tracks multiple listeners on the same emitter+event independently and removes all of them on dispose', () => {
    const bag = createSessionListenerBag()
    const emitter = makeMockEmitter()
    const fn1 = vi.fn()
    const fn2 = vi.fn()

    bag.on(emitter, 'a', fn1)
    bag.on(emitter, 'a', fn2)
    expect(emitter.listeners.a?.size ?? 0).toBe(2)

    bag.dispose()

    expect(emitter.listeners.a?.size ?? 0).toBe(0)
    emitter.emit('a')
    expect(fn1).not.toHaveBeenCalled()
    expect(fn2).not.toHaveBeenCalled()
  })
})
