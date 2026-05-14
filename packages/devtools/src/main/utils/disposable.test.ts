import { describe, it, expect, vi } from 'vitest'
import { DisposableRegistry, toDisposable } from './disposable'

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
