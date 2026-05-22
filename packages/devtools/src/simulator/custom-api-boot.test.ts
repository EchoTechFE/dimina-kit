/**
 * Failing-first tests for the NOT-YET-IMPLEMENTED `registerCustomApis` module.
 *
 * Each test names the concrete bug it would catch.
 * Implementation must be created at `./custom-api-boot.ts`.
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

// ---------------------------------------------------------------------------
// Tests
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

  it('handler forwards call to bridge.invoke and returns its value (catches handler that ignores params or discards return value)', async () => {
    const target = makeTarget()
    const returnValue = { code: 0, data: 'ok' }
    const bridge = makeBridge(['echo'], returnValue)

    await registerCustomApis(target, bridge)

    // Capture the handler registered for 'echo'
    const call = target.registerApi.mock.calls.find(([name]) => name === 'echo')
    expect(call).toBeDefined()
    const handler = call![1] as (...args: unknown[]) => Promise<unknown>

    const params = { message: 'hello' }
    const result = await handler(params)

    expect(bridge.invoke).toHaveBeenCalledWith('echo', params)
    expect(result).toBe(returnValue)
  })

  it('distinct names get distinct handlers — no closure-capture bug where all handlers invoke the last name', async () => {
    const target = makeTarget()
    const bridge = makeBridge(['a', 'b'])
    await registerCustomApis(target, bridge)

    const calls = target.registerApi.mock.calls as [string, (...args: unknown[]) => Promise<unknown>][]
    const handlerA = calls.find(([n]) => n === 'a')![1]
    const handlerB = calls.find(([n]) => n === 'b')![1]

    const paramsA = { from: 'a' }
    const paramsB = { from: 'b' }
    await handlerA(paramsA)
    await handlerB(paramsB)

    // Each invoke call must use the correct name, not the last name in the list
    expect(bridge.invoke).toHaveBeenCalledWith('a', paramsA)
    expect(bridge.invoke).toHaveBeenCalledWith('b', paramsB)
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
})
