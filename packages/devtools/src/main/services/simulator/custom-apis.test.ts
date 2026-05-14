/**
 * Failing-first contract tests for the simulator custom-API registry.
 *
 * The module under test (`./custom-apis`) does not exist yet — these tests
 * pin down the public contract from `createSimulatorApiRegistry()` and the
 * shared singleton `simulatorApiRegistry`. No Electron / IPC mocking: the
 * registry is plain TS.
 *
 * Each test describes the bug it would catch if the implementation regresses.
 *
 * Note: imports are deliberately dynamic (`await import(...)`) so the test
 * file typechecks before the implementation lands; the suite still fails at
 * runtime ("Cannot find module './custom-apis'") until the module is added.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Public-contract type aliases (kept loose so the suite typechecks before the
// real module exists; the runtime import below will fail until it does).
type SimulatorApiHandler = (params: unknown) => unknown | Promise<unknown>
interface SimulatorApiRegistry {
  register(name: string, handler: SimulatorApiHandler): () => void
  list(): string[]
  invoke(name: string, params: unknown): Promise<unknown>
  clear(): void
}
interface CustomApisModule {
  createSimulatorApiRegistry(): SimulatorApiRegistry
  simulatorApiRegistry: SimulatorApiRegistry
}

const MODULE_PATH = './custom-apis'

async function loadModule(): Promise<CustomApisModule> {
  return (await import(/* @vite-ignore */ MODULE_PATH)) as unknown as CustomApisModule
}

let createSimulatorApiRegistry: CustomApisModule['createSimulatorApiRegistry']
let simulatorApiRegistry: CustomApisModule['simulatorApiRegistry']

beforeEach(async () => {
  const mod = await loadModule()
  createSimulatorApiRegistry = mod.createSimulatorApiRegistry
  simulatorApiRegistry = mod.simulatorApiRegistry
  // Make sure the shared singleton is empty before each test that uses it.
  simulatorApiRegistry.clear()
})

describe('createSimulatorApiRegistry — register + list', () => {
  it('list() reflects a freshly registered name (catches: register not persisting handler)', () => {
    const reg = createSimulatorApiRegistry()
    reg.register('my.api', () => 1)
    expect(reg.list()).toEqual(['my.api'])
  })

  it('list() is empty on a brand-new registry (catches: cross-instance leaking / static state)', () => {
    const reg = createSimulatorApiRegistry()
    expect(reg.list()).toEqual([])
  })

  it('list() returns all registered names in stable insertion order (catches: nondeterministic ordering, e.g. relying on a re-sorted map)', () => {
    const reg = createSimulatorApiRegistry()
    reg.register('b', () => 0)
    reg.register('a', () => 0)
    reg.register('c', () => 0)
    expect(reg.list()).toEqual(['b', 'a', 'c'])
  })
})

describe('createSimulatorApiRegistry — invoke', () => {
  it('passes params through to the handler and resolves with its sync return value (catches: params dropped or wrapped)', async () => {
    const reg = createSimulatorApiRegistry()
    const handler = vi.fn((p: unknown) => ({ echoed: p }))
    reg.register('echo', handler)

    const result = await reg.invoke('echo', { x: 42 })

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith({ x: 42 })
    expect(result).toEqual({ echoed: { x: 42 } })
  })

  it('awaits and resolves with the handler\'s async return value (catches: invoke returning the Promise instead of awaiting, or not handling async at all)', async () => {
    const reg = createSimulatorApiRegistry()
    reg.register('slow', async (p: unknown) => {
      await new Promise((r) => setTimeout(r, 5))
      return { ok: true, p }
    })
    await expect(reg.invoke('slow', 'hello')).resolves.toEqual({ ok: true, p: 'hello' })
  })

  it('rejects when invoking a name that was never registered, and the error message names the missing API (catches: silent undefined return, or generic "not found" with no name)', async () => {
    const reg = createSimulatorApiRegistry()
    await expect(reg.invoke('does.not.exist', null)).rejects.toThrowError(/does\.not\.exist/)
  })

  it('rejects with the synchronous error thrown by the handler (catches: invoke swallowing sync throws or rejecting with a wrapper that loses the original error)', async () => {
    const reg = createSimulatorApiRegistry()
    const boom = new Error('sync-boom')
    reg.register('sync.throw', () => {
      throw boom
    })
    await expect(reg.invoke('sync.throw', null)).rejects.toBe(boom)
  })

  it('rejects with the handler\'s promise-rejection reason (catches: invoke turning rejections into resolved values, or eating the reason)', async () => {
    const reg = createSimulatorApiRegistry()
    const boom = new Error('async-boom')
    reg.register('async.reject', async () => {
      throw boom
    })
    await expect(reg.invoke('async.reject', null)).rejects.toBe(boom)
  })
})

describe('createSimulatorApiRegistry — re-registration semantics', () => {
  it('silently replaces a prior handler with the same name (catches: an implementation that throws or warns on duplicate names — the contract is silent replace)', () => {
    const reg = createSimulatorApiRegistry()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    reg.register('a', () => 'first')
    expect(() => reg.register('a', () => 'second')).not.toThrow()

    expect(warnSpy).not.toHaveBeenCalled()
    expect(errSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
    errSpy.mockRestore()
  })

  it('after re-registration, invoke calls the new handler, not the old one (catches: registration order kept but invoke picking the first match)', async () => {
    const reg = createSimulatorApiRegistry()
    const first = vi.fn(() => 'first')
    const second = vi.fn(() => 'second')
    reg.register('a', first)
    reg.register('a', second)

    await expect(reg.invoke('a', null)).resolves.toBe('second')
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('list() does not contain duplicate entries for the same name after re-registration (catches: list backed by an array that pushes on every register)', () => {
    const reg = createSimulatorApiRegistry()
    reg.register('a', () => 0)
    reg.register('a', () => 0)
    expect(reg.list()).toEqual(['a'])
  })
})

describe('createSimulatorApiRegistry — disposer', () => {
  it('register returns a disposer that removes the entry from list() (catches: disposer being a no-op)', () => {
    const reg = createSimulatorApiRegistry()
    const dispose = reg.register('temp', () => 0)
    expect(reg.list()).toContain('temp')
    dispose()
    expect(reg.list()).not.toContain('temp')
  })

  it('after disposing, invoke rejects with a message including the disposed name (catches: stale handler still callable post-dispose)', async () => {
    const reg = createSimulatorApiRegistry()
    const dispose = reg.register('temp', () => 'still here')
    dispose()
    await expect(reg.invoke('temp', null)).rejects.toThrowError(/temp/)
  })

  it('disposer is idempotent — second call does not throw (catches: implementation using delete + assert, or referencing already-cleared internal state)', () => {
    const reg = createSimulatorApiRegistry()
    const dispose = reg.register('a', () => 0)
    dispose()
    expect(() => dispose()).not.toThrow()
  })

  it('disposer does NOT remove a handler that was later overwritten by a fresh register (catches: disposer that blindly deletes by name instead of identity-checking against the registration it created)', async () => {
    const reg = createSimulatorApiRegistry()
    const h1 = vi.fn(() => 'h1')
    const h2 = vi.fn(() => 'h2')
    const d1 = reg.register('a', h1)
    reg.register('a', h2) // overwrites
    d1() // must NOT remove h2

    expect(reg.list()).toContain('a')
    await expect(reg.invoke('a', null)).resolves.toBe('h2')
    expect(h2).toHaveBeenCalledTimes(1)
    expect(h1).not.toHaveBeenCalled()
  })
})

describe('createSimulatorApiRegistry — clear', () => {
  it('clear() empties the registry: list() is [] and invoke rejects with name-bearing error (catches: clear that only nulls the active handler but leaves names listable)', async () => {
    const reg = createSimulatorApiRegistry()
    reg.register('a', () => 'A')
    reg.register('b', () => 'B')
    reg.clear()

    expect(reg.list()).toEqual([])
    await expect(reg.invoke('a', null)).rejects.toThrowError(/a/)
  })

  it('clear() then register() works normally (catches: clear leaving the registry in an unusable/frozen state)', async () => {
    const reg = createSimulatorApiRegistry()
    reg.register('old', () => 'old')
    reg.clear()
    reg.register('new', () => 'new')

    expect(reg.list()).toEqual(['new'])
    await expect(reg.invoke('new', null)).resolves.toBe('new')
  })
})

describe('simulatorApiRegistry — exported singleton', () => {
  it('is a SimulatorApiRegistry with the full method surface (catches: accidentally exporting an object literal or a class missing methods)', () => {
    const r: SimulatorApiRegistry = simulatorApiRegistry
    expect(typeof r.register).toBe('function')
    expect(typeof r.list).toBe('function')
    expect(typeof r.invoke).toBe('function')
    expect(typeof r.clear).toBe('function')
  })

  it('is shared across imports (same reference on a fresh dynamic import) — catches: singleton created per-import (e.g. exporting `createSimulatorApiRegistry()` from a side-effecting getter)', async () => {
    const mod = await loadModule()
    expect(mod.simulatorApiRegistry).toBe(simulatorApiRegistry)

    // Sanity: state mutations are observable through both references.
    try {
      const dispose = simulatorApiRegistry.register('__shared_sanity__', () => 'ok')
      expect(mod.simulatorApiRegistry.list()).toContain('__shared_sanity__')
      dispose()
      expect(mod.simulatorApiRegistry.list()).not.toContain('__shared_sanity__')
    } finally {
      if (simulatorApiRegistry.list().includes('__shared_sanity__')) {
        simulatorApiRegistry.clear()
      }
    }
  })

  it('is distinct from a fresh factory instance (catches: factory secretly returning the singleton)', () => {
    const fresh = createSimulatorApiRegistry()
    expect(fresh).not.toBe(simulatorApiRegistry)
  })
})
