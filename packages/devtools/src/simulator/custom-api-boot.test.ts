/**
 * Tests for `registerCustomApis` — boot-time registration of custom wx APIs.
 *
 * Each test names the concrete bug it would catch.
 *
 * Contract under test: the handler registered for each custom API is
 * "callback aware" — it bridges WeChat-style `success/fail/complete`
 * callback ids to the real callback functions minted on the container side
 * (`this.createCallbackFunction`). The handler is invoked by the container
 * as `handler.call(miniApp, params)`, so its `this` is the MiniApp instance.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerCustomApis } from './custom-api-boot'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTarget() {
  return { registerApi: vi.fn() }
}

function makeBridge(names: string[], invokeResult: unknown = undefined) {
  return {
    list: vi.fn().mockResolvedValue(names),
    invoke: vi.fn().mockResolvedValue(invokeResult),
  }
}

/**
 * Stand-in for the MiniApp instance used as the handler's `this`.
 * `createCallbackFunction(id)` returns a fresh spy per truthy id, or
 * `undefined` for a falsy id — mirroring the real container behavior.
 * Tests read `fakeMiniApp.createCallbackFunction.mock.results` to grab the
 * spy minted for a given callback id and assert how it was invoked.
 */
function makeFakeMiniApp() {
  return {
    createCallbackFunction: vi.fn((id: unknown) => (id ? vi.fn() : undefined)),
  }
}

/** Returns the callback spy that `createCallbackFunction` produced for `id`. */
function callbackSpyFor(
  fakeMiniApp: ReturnType<typeof makeFakeMiniApp>,
  id: unknown,
) {
  const fn = fakeMiniApp.createCallbackFunction
  const idx = fn.mock.calls.findIndex(([arg]) => arg === id)
  if (idx === -1) return undefined
  return fn.mock.results[idx]?.value as ReturnType<typeof vi.fn> | undefined
}

/** Pull the handler registered under `name` off the target spy. */
function handlerFor(
  target: ReturnType<typeof makeTarget>,
  name: string,
): (this: unknown, params: unknown) => Promise<unknown> {
  const call = target.registerApi.mock.calls.find(([n]) => n === name)
  expect(call).toBeDefined()
  return call![1] as (this: unknown, params: unknown) => Promise<unknown>
}

// ---------------------------------------------------------------------------
// Tests — boot/registration semantics (existing, still valid)
// ---------------------------------------------------------------------------

describe('registerCustomApis', () => {
  it('bridge=undefined → no-op: resolves without calling registerApi (catches crash on absent bridge)', async () => {
    const target = makeTarget()
    await expect(registerCustomApis(target, undefined)).resolves.toBeUndefined()
    expect(target.registerApi).not.toHaveBeenCalled()
  })

  it('registers every name returned by list() (catches partial registration when list returns multiple names)', async () => {
    const target = makeTarget()
    const bridge = makeBridge(['login', 'pay'])
    await registerCustomApis(target, bridge)
    expect(target.registerApi).toHaveBeenCalledTimes(2)
    expect(target.registerApi).toHaveBeenCalledWith('login', expect.any(Function))
    expect(target.registerApi).toHaveBeenCalledWith('pay', expect.any(Function))
  })

  it('ORDERING — await resolves only after all registerApi calls (catches fire-and-forget bug where caller boots mini-app before APIs are registered)', async () => {
    const target = makeTarget()
    // list() resolves after one microtask tick to simulate async IPC latency
    const bridge = {
      list: vi.fn().mockImplementation(() => Promise.resolve(['login'])),
      invoke: vi.fn().mockResolvedValue(undefined),
    }

    await registerCustomApis(target, bridge)

    // If registerCustomApis resolved before awaiting list(), this would be 0
    expect(target.registerApi).toHaveBeenCalledWith('login', expect.any(Function))
  })

  it('list() rejection is non-fatal: resolves without calling registerApi (catches unhandled-rejection crash)', async () => {
    const target = makeTarget()
    const bridge = {
      list: vi.fn().mockRejectedValue(new Error('bridge offline')),
      invoke: vi.fn(),
    }
    await expect(registerCustomApis(target, bridge)).resolves.toBeUndefined()
    expect(target.registerApi).not.toHaveBeenCalled()
  })

  describe('hung list() timeout behavior', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('hung list() → resolves after timeoutMs without registering anything, and emits console.warn (catches infinite hang when IPC never responds)', async () => {
      const target = makeTarget()
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const bridge = {
        // A promise that never settles
        list: vi.fn().mockReturnValue(new Promise<string[]>(() => {})),
        invoke: vi.fn(),
      }

      const timeoutMs = 500
      const pending = registerCustomApis(target, bridge, { timeoutMs })

      // Advance fake clock past the timeout so the module's internal timer fires
      await vi.advanceTimersByTimeAsync(timeoutMs + 10)

      await expect(pending).resolves.toBeUndefined()
      expect(target.registerApi).not.toHaveBeenCalled()
      expect(warnSpy).toHaveBeenCalled()

      warnSpy.mockRestore()
    })
  })

  // -------------------------------------------------------------------------
  // Tests — registered handler behavior (callback-aware contract)
  //
  // The handler is `this`-bound: the container invokes it as
  // `handler.call(miniApp, params)`. These tests call it the same way via a
  // fake MiniApp so the `this.createCallbackFunction` path is exercised.
  // -------------------------------------------------------------------------

  describe('registered handler — bridge forwarding', () => {
    it('handler forwards non-callback params to bridge.invoke and returns its promise value (catches handler that ignores params or discards return value)', async () => {
      const target = makeTarget()
      const returnValue = { code: 0, data: 'ok' }
      const bridge = makeBridge(['echo'], returnValue)
      await registerCustomApis(target, bridge)

      const handler = handlerFor(target, 'echo')
      const result = await handler.call(makeFakeMiniApp(), { message: 'hello' })

      expect(bridge.invoke).toHaveBeenCalledWith(
        'echo',
        expect.objectContaining({ message: 'hello' }),
      )
      expect(result).toBe(returnValue)
    })

    it('handler strips success/fail/complete callback ids before forwarding to bridge.invoke (catches leaking renderer-only callback ids into the main process)', async () => {
      const target = makeTarget()
      const bridge = makeBridge(['echo'], { ok: true })
      await registerCustomApis(target, bridge)

      const handler = handlerFor(target, 'echo')
      await handler.call(makeFakeMiniApp(), {
        message: 'hello',
        success: 'cb-success-1',
        fail: 'cb-fail-1',
        complete: 'cb-complete-1',
      })

      expect(bridge.invoke).toHaveBeenCalledTimes(1)
      const forwarded = bridge.invoke.mock.calls[0]![1] as Record<string, unknown>
      // Real work params survive…
      expect(forwarded).toMatchObject({ message: 'hello' })
      // …but the callback ids are renderer-side only and must NOT cross over.
      expect(forwarded).not.toHaveProperty('success')
      expect(forwarded).not.toHaveProperty('fail')
      expect(forwarded).not.toHaveProperty('complete')
    })

    it('forwards a non-object param verbatim to bridge.invoke (catches primitive payload clobbered to {})', async () => {
      const target = makeTarget()
      const bridge = makeBridge(['echo'], { ok: true })
      await registerCustomApis(target, bridge)

      const handler = handlerFor(target, 'echo')
      await handler.call(makeFakeMiniApp(), 'raw-string')

      expect(bridge.invoke).toHaveBeenCalledWith('echo', 'raw-string')
    })

    it('distinct names get distinct handlers — no closure-capture bug where all handlers invoke the last name', async () => {
      const target = makeTarget()
      const bridge = makeBridge(['a', 'b'])
      await registerCustomApis(target, bridge)

      const handlerA = handlerFor(target, 'a')
      const handlerB = handlerFor(target, 'b')

      await handlerA.call(makeFakeMiniApp(), { from: 'a' })
      await handlerB.call(makeFakeMiniApp(), { from: 'b' })

      // Each invoke call must use the correct name, not the last name in the list
      expect(bridge.invoke).toHaveBeenCalledWith('a', expect.objectContaining({ from: 'a' }))
      expect(bridge.invoke).toHaveBeenCalledWith('b', expect.objectContaining({ from: 'b' }))
    })
  })

  describe('registered handler — callback dispatch on success', () => {
    it('resolves success callback via this.createCallbackFunction(params.success) and invokes it with the bridge result (catches handler that never fires wx success callback)', async () => {
      const target = makeTarget()
      const result = { token: 'abc' }
      const bridge = makeBridge(['login'], result)
      await registerCustomApis(target, bridge)

      const miniApp = makeFakeMiniApp()
      const handler = handlerFor(target, 'login')
      await handler.call(miniApp, { success: 'cb-success' })

      expect(miniApp.createCallbackFunction).toHaveBeenCalledWith('cb-success')
      const successSpy = callbackSpyFor(miniApp, 'cb-success')
      expect(successSpy).toBeDefined()
      expect(successSpy).toHaveBeenCalledWith(result)
    })

    it('does NOT invoke the fail callback on success (catches handler that fires both branches)', async () => {
      const target = makeTarget()
      const bridge = makeBridge(['login'], { token: 'abc' })
      await registerCustomApis(target, bridge)

      const miniApp = makeFakeMiniApp()
      const handler = handlerFor(target, 'login')
      await handler.call(miniApp, { success: 'cb-success', fail: 'cb-fail' })

      const failSpy = callbackSpyFor(miniApp, 'cb-fail')
      // fail callback may or may not have been minted, but must never be called
      expect(failSpy?.mock.calls ?? []).toHaveLength(0)
    })

    it('invokes the complete callback on success (catches handler that skips complete on the happy path)', async () => {
      const target = makeTarget()
      const bridge = makeBridge(['login'], { token: 'abc' })
      await registerCustomApis(target, bridge)

      const miniApp = makeFakeMiniApp()
      const handler = handlerFor(target, 'login')
      await handler.call(miniApp, { success: 'cb-success', complete: 'cb-complete' })

      expect(miniApp.createCallbackFunction).toHaveBeenCalledWith('cb-complete')
      const completeSpy = callbackSpyFor(miniApp, 'cb-complete')
      expect(completeSpy).toBeDefined()
      expect(completeSpy).toHaveBeenCalled()
      // complete must run after success on the happy path
      const successSpy = callbackSpyFor(miniApp, 'cb-success')
      expect(completeSpy!.mock.invocationCallOrder[0]!).toBeGreaterThan(
        successSpy!.mock.invocationCallOrder[0]!,
      )
    })
  })

  describe('registered handler — callback dispatch on failure', () => {
    it('resolves fail callback via this.createCallbackFunction(params.fail) and invokes it with a wx-style errMsg (catches handler that swallows bridge.invoke rejection)', async () => {
      const target = makeTarget()
      const bridge = {
        list: vi.fn().mockResolvedValue(['login']),
        invoke: vi.fn().mockRejectedValue(new Error('boom')),
      }
      await registerCustomApis(target, bridge)

      const miniApp = makeFakeMiniApp()
      const handler = handlerFor(target, 'login')
      // handler still returns the bridge promise — it rejects; swallow it here.
      await handler.call(miniApp, { fail: 'cb-fail' }).catch(() => {})

      expect(miniApp.createCallbackFunction).toHaveBeenCalledWith('cb-fail')
      const failSpy = callbackSpyFor(miniApp, 'cb-fail')
      expect(failSpy).toBeDefined()
      expect(failSpy).toHaveBeenCalledWith({ errMsg: 'login:fail boom' })
    })

    it('does NOT invoke the success callback on failure (catches handler that fires success regardless of outcome)', async () => {
      const target = makeTarget()
      const bridge = {
        list: vi.fn().mockResolvedValue(['login']),
        invoke: vi.fn().mockRejectedValue(new Error('boom')),
      }
      await registerCustomApis(target, bridge)

      const miniApp = makeFakeMiniApp()
      const handler = handlerFor(target, 'login')
      await handler.call(miniApp, { success: 'cb-success', fail: 'cb-fail' }).catch(() => {})

      const successSpy = callbackSpyFor(miniApp, 'cb-success')
      expect(successSpy?.mock.calls ?? []).toHaveLength(0)
    })

    it('invokes the complete callback on failure (catches handler that skips complete when the bridge rejects)', async () => {
      const target = makeTarget()
      const bridge = {
        list: vi.fn().mockResolvedValue(['login']),
        invoke: vi.fn().mockRejectedValue(new Error('boom')),
      }
      await registerCustomApis(target, bridge)

      const miniApp = makeFakeMiniApp()
      const handler = handlerFor(target, 'login')
      await handler.call(miniApp, { fail: 'cb-fail', complete: 'cb-complete' }).catch(() => {})

      expect(miniApp.createCallbackFunction).toHaveBeenCalledWith('cb-complete')
      const completeSpy = callbackSpyFor(miniApp, 'cb-complete')
      expect(completeSpy).toBeDefined()
      expect(completeSpy).toHaveBeenCalled()
      // complete must run after fail on the error path
      const failSpy = callbackSpyFor(miniApp, 'cb-fail')
      expect(completeSpy!.mock.invocationCallOrder[0]!).toBeGreaterThan(
        failSpy!.mock.invocationCallOrder[0]!,
      )
    })
  })

  describe('registered handler — missing callback ids are non-fatal', () => {
    it('success path with no success/complete ids does not throw (catches handler that calls undefined when a callback id is absent)', async () => {
      const target = makeTarget()
      const bridge = makeBridge(['login'], { token: 'abc' })
      await registerCustomApis(target, bridge)

      const miniApp = makeFakeMiniApp()
      const handler = handlerFor(target, 'login')

      // No callback ids at all — createCallbackFunction returns undefined.
      // The handler must still resolve cleanly to the bridge result.
      await expect(handler.call(miniApp, { message: 'hi' })).resolves.toEqual({ token: 'abc' })
    })

    it('failure path with no fail/complete ids does not throw (catches handler that calls undefined fail callback on rejection)', async () => {
      const target = makeTarget()
      const bridge = {
        list: vi.fn().mockResolvedValue(['login']),
        invoke: vi.fn().mockRejectedValue(new Error('boom')),
      }
      await registerCustomApis(target, bridge)

      const miniApp = makeFakeMiniApp()
      const handler = handlerFor(target, 'login')

      // The handler must not throw synchronously while dispatching callbacks;
      // the returned promise still rejects with the bridge error.
      let threwSync = false
      let p: Promise<unknown>
      try {
        p = handler.call(miniApp, { message: 'hi' })
      } catch {
        threwSync = true
        p = Promise.resolve()
      }
      await p.catch(() => {})
      expect(threwSync).toBe(false)
    })
  })
})
