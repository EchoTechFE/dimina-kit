/**
 * TDD failing tests for the (not-yet-implemented) contribution-binding layer
 * `bindContributions(deps)` in `./workbench-bindings.ts`.
 *
 * `workbench()` collects host contributions into `DeferredContributions`
 * (see `./workbench-config-adapter.ts`). `bindContributions` wires the three
 * runtime-contribution kinds to their correct backends:
 *
 *  - `simulatorApis`  → devtools-native `ctx.simulatorApis.register(name, handler)`
 *                       (real devtools path; projected into the mini-program as
 *                       `wx.<name>`).
 *  - `hostServices`   → injected workbench `TypedIpcRegistry.handle(
 *                       '__workbench:host:<name>', handler)` (trusted-webview
 *                       host RPC over WireTransport).
 *  - `events`         → injected workbench `EventBus.bindDeclaredEvents(events)`
 *                       (main→webview one-way declared push).
 *
 * The function is pure w.r.t. electron: all backends are injected. Tests use
 * only type-only imports for the contract + fully fake deps, so importing this
 * test never pulls electron in. (Sibling `register` real return value, from
 * `../services/simulator/custom-apis.ts`, is `() => void` — an unregister
 * function — so `dispose()` is expected to unregister simulatorApis too.)
 */
import { describe, it, expect, vi } from 'vitest'

import type {
  BindContributionsDeps,
  BindContributionsResult,
} from './workbench-bindings.js'
import { bindContributions } from './workbench-bindings.js'

const HOST_PREFIX = '__workbench:host:'

/** Fake devtools ctx — only `simulatorApis` is consulted by `bindContributions`. */
function makeFakeCtx() {
  // Real `SimulatorApiRegistry.register` returns an unregister `() => void`.
  // Give each register call its own spy so dispose() can be asserted per-name.
  const unregisterSpies: Array<ReturnType<typeof vi.fn>> = []
  const register = vi.fn((_name: string, _handler: unknown) => {
    const unreg = vi.fn()
    unregisterSpies.push(unreg)
    return unreg
  })
  const ctx = { simulatorApis: { register } }
  return { ctx, register, unregisterSpies }
}

/** Fake injected workbench TypedIpcRegistry. */
function makeFakeIpc(invokeResult?: unknown) {
  const disposeSpies: Array<ReturnType<typeof vi.fn>> = []
  const handle = vi.fn((_channel: string, _handler: unknown) => {
    const dispose = vi.fn()
    disposeSpies.push(dispose)
    return { dispose }
  })
  const invoke = vi.fn(async (..._args: unknown[]) => invokeResult)
  return { ipc: { handle, invoke }, handle, invoke, disposeSpies }
}

/** Fake injected workbench EventBus (structural). */
function makeFakeBus() {
  const bindDeclaredEvents = vi.fn()
  return { bus: { bindDeclaredEvents }, bindDeclaredEvents }
}

/**
 * Assemble `BindContributionsDeps` from fakes. `deferred` is a structural stub;
 * cast through the contract type so we don't depend on electron-touching ctx.
 */
function makeDeps(
  deferred: BindContributionsDeps['deferred'],
  opts: { invokeResult?: unknown } = {},
) {
  const { ctx, register, unregisterSpies } = makeFakeCtx()
  const { ipc, handle, invoke, disposeSpies } = makeFakeIpc(opts.invokeResult)
  const { bus, bindDeclaredEvents } = makeFakeBus()
  const deps = {
    ctx: ctx as unknown as BindContributionsDeps['ctx'],
    deferred,
    ipc: ipc as unknown as BindContributionsDeps['ipc'],
    bus,
  } satisfies BindContributionsDeps
  return {
    deps,
    register,
    unregisterSpies,
    handle,
    invoke,
    disposeSpies,
    bindDeclaredEvents,
  }
}

describe('bindContributions', () => {
  // Contract 1
  it('registers each simulatorApi on ctx.simulatorApis.register with correct name + handler', () => {
    const loginFn = vi.fn()
    const getUserFn = vi.fn()
    const { deps, register } = makeDeps({
      simulatorApis: { login: loginFn, getUser: getUserFn },
    } as unknown as BindContributionsDeps['deferred'])

    bindContributions(deps)

    expect(register).toHaveBeenCalledTimes(2)
    expect(register).toHaveBeenCalledWith('login', loginFn)
    expect(register).toHaveBeenCalledWith('getUser', getUserFn)
  })

  // Contract 2
  it('handles each hostService on ipc with the "__workbench:host:" channel prefix + name', () => {
    const getUserFn = vi.fn()
    const { deps, handle } = makeDeps({
      hostServices: { getUser: getUserFn },
    } as unknown as BindContributionsDeps['deferred'])

    bindContributions(deps)

    expect(handle).toHaveBeenCalledTimes(1)
    expect(handle).toHaveBeenCalledWith(`${HOST_PREFIX}getUser`, getUserFn)
  })

  // Contract 3
  it('binds declared events via bus.bindDeclaredEvents once with the same events array', () => {
    const ev1 = { name: 'a' }
    const ev2 = { name: 'b' }
    const events = [ev1, ev2]
    const { deps, bindDeclaredEvents } = makeDeps({
      events,
    } as unknown as BindContributionsDeps['deferred'])

    bindContributions(deps)

    expect(bindDeclaredEvents).toHaveBeenCalledTimes(1)
    expect(bindDeclaredEvents).toHaveBeenCalledWith(events)
    // same reference, not a copy
    expect(bindDeclaredEvents.mock.calls[0][0]).toBe(events)
  })

  // Contract 4
  it('does nothing and does not throw when all three kinds are absent', () => {
    const { deps, register, handle, bindDeclaredEvents } = makeDeps(
      {} as unknown as BindContributionsDeps['deferred'],
    )

    expect(() => bindContributions(deps)).not.toThrow()
    expect(register).not.toHaveBeenCalled()
    expect(handle).not.toHaveBeenCalled()
    expect(bindDeclaredEvents).not.toHaveBeenCalled()
  })

  // Contract 5
  it('callHost delegates to ipc.invoke("__workbench:host:"+name, ...args) and passes the result through', async () => {
    const SENTINEL = Symbol('host-result')
    const getUserFn = vi.fn()
    const { deps, invoke } = makeDeps(
      { hostServices: { getUser: getUserFn } } as unknown as BindContributionsDeps['deferred'],
      { invokeResult: SENTINEL },
    )

    const result: BindContributionsResult = bindContributions(deps)
    const out = await result.callHost('getUser', { id: 1 })

    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith(`${HOST_PREFIX}getUser`, { id: 1 })
    expect(out).toBe(SENTINEL)
  })

  // Contract 6
  it('dispose() unbinds host RPC handlers and unregisters simulatorApis', () => {
    const loginFn = vi.fn()
    const getUserFn = vi.fn()
    const { deps, disposeSpies, unregisterSpies } = makeDeps({
      simulatorApis: { login: loginFn },
      hostServices: { getUser: getUserFn },
    } as unknown as BindContributionsDeps['deferred'])

    const result = bindContributions(deps)

    // not disposed before dispose()
    expect(disposeSpies).toHaveLength(1)
    expect(disposeSpies[0]).not.toHaveBeenCalled()
    expect(unregisterSpies).toHaveLength(1)
    expect(unregisterSpies[0]).not.toHaveBeenCalled()

    result.dispose()

    // host RPC handler Disposable.dispose called
    expect(disposeSpies[0]).toHaveBeenCalledTimes(1)
    // simulatorApi unregister (real register() returns () => void) called
    expect(unregisterSpies[0]).toHaveBeenCalledTimes(1)
  })

  // Contract 7
  it('dispose() is idempotent: repeated calls do not throw and unbind exactly once', () => {
    const { deps, disposeSpies, unregisterSpies } = makeDeps({
      simulatorApis: { login: vi.fn() },
      hostServices: { getUser: vi.fn() },
    } as unknown as BindContributionsDeps['deferred'])

    const result = bindContributions(deps)

    result.dispose()
    expect(() => {
      result.dispose()
      result.dispose()
    }).not.toThrow()

    expect(disposeSpies[0]).toHaveBeenCalledTimes(1)
    expect(unregisterSpies[0]).toHaveBeenCalledTimes(1)
  })
})
