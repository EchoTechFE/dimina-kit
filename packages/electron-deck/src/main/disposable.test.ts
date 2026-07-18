import { describe, it, expect, vi } from 'vitest'
import { DisposableRegistry, toDisposable, SyncDisposableRegistry } from './disposable.js'

describe('toDisposable', () => {
  it('invokes fn exactly once when dispose() is called', () => {
    const fn = vi.fn()
    const d = toDisposable(fn)
    d.dispose()
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('is idempotent: calling dispose() twice still only invokes fn once', () => {
    const fn = vi.fn()
    const d = toDisposable(fn)
    d.dispose()
    d.dispose()
    expect(fn).toHaveBeenCalledTimes(1)
  })
})

describe('DisposableRegistry.add', () => {
  it('triggers a Disposable input on disposeAll()', async () => {
    const reg = new DisposableRegistry()
    const dispose = vi.fn()
    reg.add({ dispose })
    await reg.disposeAll()
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('triggers a plain DisposeFn input on disposeAll()', async () => {
    const reg = new DisposableRegistry()
    const fn = vi.fn()
    reg.add(fn)
    await reg.disposeAll()
    expect(fn).toHaveBeenCalledTimes(1)
  })
})

describe('DisposableRegistry order', () => {
  it('disposes items in LIFO order (C, B, A)', async () => {
    const reg = new DisposableRegistry()
    const calls: string[] = []
    reg.add(() => { calls.push('A') })
    reg.add(() => { calls.push('B') })
    reg.add(() => { calls.push('C') })
    await reg.disposeAll()
    expect(calls).toEqual(['C', 'B', 'A'])
  })
})

describe('DisposableRegistry error aggregation', () => {
  it('continues through sync throws and async rejections, then rejects with an aggregate', async () => {
    const reg = new DisposableRegistry()
    const calls: string[] = []
    reg.add(() => { calls.push('1') })
    reg.add(() => { calls.push('2'); throw new Error('boom-sync') })
    reg.add(async () => { calls.push('3'); throw new Error('boom-async') })
    reg.add(() => { calls.push('4') })
    reg.add(() => { calls.push('5') })

    let caught: unknown
    try {
      await reg.disposeAll()
    } catch (e) {
      caught = e
    }

    // All 5 items must have been invoked despite the failures
    expect(calls.sort()).toEqual(['1', '2', '3', '4', '5'])
    expect(caught).toBeDefined()

    // Both error messages should surface (either on AggregateError.errors or via stringification)
    const err = caught as Error & { errors?: Error[] }
    const haystack =
      (err.errors?.map((x) => x.message).join('|') ?? '') +
      '|' +
      String(err.message ?? '') +
      '|' +
      String(err)
    expect(haystack).toContain('boom-sync')
    expect(haystack).toContain('boom-async')
  })
})

describe('DisposableRegistry async awaiting', () => {
  it('awaits async dispose functions before disposeAll() resolves', async () => {
    const reg = new DisposableRegistry()
    let resolved = false
    reg.add(async () => {
      await new Promise<void>((r) => setTimeout(r, 10))
      resolved = true
    })
    await reg.disposeAll()
    expect(resolved).toBe(true)
  })
})

describe('DisposableRegistry handle', () => {
  it('handle.dispose() releases just that item exactly once', async () => {
    const reg = new DisposableRegistry()
    const fn = vi.fn()
    const handle = reg.add(fn)

    handle.dispose()
    expect(fn).toHaveBeenCalledTimes(1)

    await reg.disposeAll()
    expect(fn).toHaveBeenCalledTimes(1)
  })
})

describe('DisposableRegistry post-disposal behavior', () => {
  it('throws when add() is called after disposeAll()', async () => {
    const reg = new DisposableRegistry()
    await reg.disposeAll()
    expect(() => reg.add(() => {})).toThrow(/cannot add to disposed registry/)
  })
})

describe('DisposableRegistry idempotency', () => {
  it('calling disposeAll() twice does not re-invoke already-released items and does not throw', async () => {
    const reg = new DisposableRegistry()
    const fn = vi.fn()
    reg.add(fn)
    await reg.disposeAll()
    await expect(reg.disposeAll()).resolves.toBeUndefined()
    expect(fn).toHaveBeenCalledTimes(1)
  })
})

describe('DisposableRegistry.dispose alias', () => {
  it('behaves the same as disposeAll()', async () => {
    const reg = new DisposableRegistry()
    const calls: string[] = []
    reg.add(() => { calls.push('A') })
    reg.add(() => { calls.push('B') })
    await reg.dispose()
    expect(calls).toEqual(['B', 'A'])
  })
})

// SyncDisposableRegistry exists because DisposableRegistry.disposeAll() is async:
// a fire-and-forget caller (the common pattern in this codebase) only gets a
// synchronous guarantee for the *last-registered* (first-run) entry — every
// subsequent entry runs a microtask tick later. Teardown that must be fully
// visible in the same tick (e.g. removing an event listener before a
// dispose-then-immediately-recreate sequence) needs every entry's side effect
// to have already happened by the time disposeAll() returns control, with no
// await at the call site.

describe('SyncDisposableRegistry synchronous execution', () => {
  it('has every registered fn already invoked on the line right after disposeAll(), with no await', () => {
    const reg = new SyncDisposableRegistry()
    const calls: string[] = []
    reg.add(() => { calls.push('item1') })
    reg.add(() => { calls.push('item2') })
    reg.add(() => { calls.push('item3') })

    reg.disposeAll()

    // No await, no microtask flush: if disposeAll() only synchronously ran
    // the first (reversed) entry and deferred the rest, this array would be
    // incomplete right here.
    expect(calls).toHaveLength(3)
    expect(calls).toEqual(['item3', 'item2', 'item1'])
  })
})

describe('SyncDisposableRegistry LIFO order', () => {
  it('disposes items in LIFO order (C, B, A) for A, B, C registered in that order', () => {
    const reg = new SyncDisposableRegistry()
    const calls: string[] = []
    reg.add(() => { calls.push('A') })
    reg.add(() => { calls.push('B') })
    reg.add(() => { calls.push('C') })

    reg.disposeAll()

    expect(calls).toEqual(['C', 'B', 'A'])
  })
})

describe('SyncDisposableRegistry error aggregation', () => {
  it('runs every entry despite a middle one throwing, then throws an AggregateError with just that one error', () => {
    const reg = new SyncDisposableRegistry()
    const calls: string[] = []
    const boom = new Error('boom-middle')

    reg.add(() => { calls.push('A') })
    reg.add(() => {
      calls.push('B')
      throw boom
    })
    reg.add(() => { calls.push('C') })

    let caught: unknown
    try {
      reg.disposeAll()
    } catch (e) {
      caught = e
    }

    // All three entries must have run, regardless of the throw in the middle.
    expect(calls.sort()).toEqual(['A', 'B', 'C'])

    expect(caught).toBeInstanceOf(AggregateError)
    const agg = caught as AggregateError
    expect(agg.errors).toHaveLength(1)
    expect(agg.errors[0]).toBe(boom)
  })
})

describe('SyncDisposableRegistry idempotency', () => {
  it('does not re-invoke already-run entries on a second disposeAll() call', () => {
    const reg = new SyncDisposableRegistry()
    const fn = vi.fn()
    reg.add(fn)

    reg.disposeAll()
    expect(fn).toHaveBeenCalledTimes(1)

    reg.disposeAll()
    expect(fn).toHaveBeenCalledTimes(1)
  })
})

describe('SyncDisposableRegistry post-disposal behavior', () => {
  it('throws when add() is called after disposeAll(), matching DisposableRegistry', () => {
    const reg = new SyncDisposableRegistry()
    reg.disposeAll()
    expect(() => reg.add(() => {})).toThrow(/cannot add to disposed registry/)
  })

  it('never silently accepts (and leaks) an entry registered after disposeAll()', () => {
    const reg = new SyncDisposableRegistry()
    reg.disposeAll()
    const fn = vi.fn()
    expect(() => reg.add(fn)).toThrow()
    // The entry must never have been queued at all — a second disposeAll()
    // (already a no-op post-disposal) must not somehow run it later either.
    reg.disposeAll()
    expect(fn).not.toHaveBeenCalled()
  })
})

describe('SyncDisposableRegistry early release via handle', () => {
  it('skips an entry that was individually disposed before disposeAll(), while running the rest', () => {
    const reg = new SyncDisposableRegistry()
    const a = vi.fn()
    const b = vi.fn()
    const c = vi.fn()
    reg.add(a)
    const handleB = reg.add(b)
    reg.add(c)

    handleB.dispose()
    expect(b).toHaveBeenCalledTimes(1)

    reg.disposeAll()

    expect(a).toHaveBeenCalledTimes(1)
    expect(c).toHaveBeenCalledTimes(1)
    // b was released ahead of time; disposeAll() must not call it again.
    expect(b).toHaveBeenCalledTimes(1)
  })
})

describe('SyncDisposableRegistry.size', () => {
  it('tracks live entry count through add(), early release, and disposeAll()', () => {
    const reg = new SyncDisposableRegistry()
    expect(reg.size).toBe(0)

    reg.add(() => {})
    expect(reg.size).toBe(1)

    const handle2 = reg.add(() => {})
    expect(reg.size).toBe(2)

    reg.add(() => {})
    expect(reg.size).toBe(3)

    handle2.dispose()
    expect(reg.size).toBe(2)

    reg.disposeAll()
    expect(reg.size).toBe(0)
  })
})

describe('SyncDisposableRegistry thenable return values', () => {
  it('treats a thenable return value as already-run and returns synchronously without waiting on it', () => {
    const reg = new SyncDisposableRegistry()
    const calls: string[] = []
    // Intentionally not a real Promise: a real Promise that never resolves
    // would still let disposeAll() return synchronously (nothing here awaits
    // it), but using a bare thenable removes any doubt that some hidden
    // microtask machinery is involved in making the assertion pass.
    const neverSettlingThenable = { then() {} }

    const normalFn = vi.fn(() => { calls.push('normal') })
    const thenableFn = vi.fn(() => {
      calls.push('thenable')
      return neverSettlingThenable as unknown as void
    })

    reg.add(normalFn)
    reg.add(thenableFn)

    const start = Date.now()
    reg.disposeAll()
    const elapsed = Date.now() - start

    // If disposeAll() were awaiting the thenable, this thenable never
    // settles, so control would never reach here at all.
    expect(elapsed).toBeLessThan(50)
    // LIFO: thenableFn was registered last, so it runs first.
    expect(calls).toEqual(['thenable', 'normal'])

    // The thenable-returning entry must be considered already-disposed:
    // a second disposeAll() must not invoke it again.
    reg.disposeAll()
    expect(thenableFn).toHaveBeenCalledTimes(1)
  })
})
