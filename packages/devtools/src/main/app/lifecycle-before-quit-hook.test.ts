/**
 * `registerAppLifecycle` before-quit teardown hook contract.
 *
 * Background: Electron's `will-quit` does NOT wait for async teardown (the
 * framework fires `void this.shutdown()`, unawaited, no `preventDefault()`),
 * so a host-toolbar WebContentsView + its MessagePortMain can leak into
 * Chromium's native shutdown teardown — closing the port from a later JS
 * `'destroyed'` handler then crashes natively. The fix tears the view down
 * EARLIER and SYNCHRONOUSLY, at `before-quit` (main loop still fully healthy),
 * via an optional `onBeforeQuit` hook threaded through `registerAppLifecycle`.
 *
 * `registerAppLifecycle` does not yet accept an argument — these tests are
 * RED until it does. Harness style lifted from `quit-flag-onclose.test.ts`
 * (hoisted electron `app` event-emitter stub), narrowed to just `app` +
 * `globalShortcut` since `lifecycle.ts` imports nothing else from electron.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const stubs = vi.hoisted(() => {
  type AnyFn = (...args: unknown[]) => unknown
  type EventBag = Record<string, Set<AnyFn>>

  function makeEmitter() {
    const listeners: EventBag = {}
    return {
      listeners,
      on(event: string, fn: AnyFn) {
        ;(listeners[event] ??= new Set()).add(fn)
        return this
      },
      off(event: string, fn: AnyFn) {
        listeners[event]?.delete(fn)
        return this
      },
      removeListener(event: string, fn: AnyFn) {
        listeners[event]?.delete(fn)
        return this
      },
      emit(event: string, ...args: unknown[]) {
        for (const fn of [...(listeners[event] ?? [])]) fn(...args)
      },
    }
  }

  return { makeEmitter }
})

vi.mock('electron', () => {
  const appEmitter = stubs.makeEmitter()
  const app = { ...appEmitter, quit: vi.fn() }
  const globalShortcut = {
    register: vi.fn(() => false),
    unregister: vi.fn(),
    unregisterAll: vi.fn(),
  }
  return { app, globalShortcut, default: {} }
})

type FakeAppEmitter = { emit: (event: string, ...args: unknown[]) => void }

let registerAppLifecycle: typeof import('./lifecycle.js').registerAppLifecycle
let isAppQuitting: typeof import('./lifecycle.js').isAppQuitting
let electron: typeof import('electron')

function emitBeforeQuit(): void {
  ;(electron.app as unknown as FakeAppEmitter).emit('before-quit', {
    preventDefault: () => {},
  })
}

beforeEach(async () => {
  vi.resetModules()
  electron = await import('electron')
  ;({ registerAppLifecycle, isAppQuitting } = await import('./lifecycle.js'))
})

describe('registerAppLifecycle: optional onBeforeQuit teardown hook', () => {
  it('invokes the callback exactly once when before-quit fires', () => {
    const onBeforeQuit = vi.fn()

    registerAppLifecycle(onBeforeQuit)
    expect(onBeforeQuit).not.toHaveBeenCalled()

    emitBeforeQuit()

    expect(onBeforeQuit).toHaveBeenCalledTimes(1)
  })

  it('invokes the callback again on every subsequent before-quit emission', () => {
    const onBeforeQuit = vi.fn()

    registerAppLifecycle(onBeforeQuit)

    // Some hosts emit `before-quit` defensively more than once (e.g. macOS
    // menu Quit racing a second app.quit() call) — the hook must not be a
    // one-shot `once()` registration.
    emitBeforeQuit()
    emitBeforeQuit()

    expect(onBeforeQuit).toHaveBeenCalledTimes(2)
  })

  it('registerAppLifecycle() with no argument keeps working exactly as before (backward-compat regression guard)', () => {
    expect(isAppQuitting()).toBe(false)

    expect(() => registerAppLifecycle()).not.toThrow()
    expect(isAppQuitting()).toBe(false)

    expect(() => emitBeforeQuit()).not.toThrow()
    expect(isAppQuitting()).toBe(true)
  })

  it('a throwing onBeforeQuit callback is isolated: isAppQuitting still flips true and the handler does not rethrow', () => {
    const boom = new Error('boom')
    const onBeforeQuit = vi.fn(() => {
      throw boom
    })
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    registerAppLifecycle(onBeforeQuit)

    // A throw escaping a real Electron `before-quit` listener becomes an
    // uncaught exception at the process level — the handler must isolate it
    // the same way `invokeReadyHandler` isolates onReady handlers in
    // host-toolbar-port-channel.ts (try/catch + console.error, no rethrow).
    expect(() => emitBeforeQuit()).not.toThrow()

    expect(onBeforeQuit).toHaveBeenCalledTimes(1)
    expect(
      isAppQuitting(),
      'a throwing teardown hook must not stop the quit flag from flipping',
    ).toBe(true)
    expect(consoleErrorSpy).toHaveBeenCalled()

    consoleErrorSpy.mockRestore()
  })
})
