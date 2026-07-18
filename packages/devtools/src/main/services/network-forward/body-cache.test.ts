/**
 * Unit tests for PrefetchCache — the bounded, TTL'd, "prime now / read later"
 * promise cache the network body prefetch uses to answer
 * Network.getResponseBody / Network.getRequestPostData lookups without
 * re-issuing a debugger round-trip for every panel click. Pure: no electron,
 * no real timers — TTL is driven entirely by the injected `now()` clock.
 */
import { describe, expect, it, vi } from 'vitest'
import { PrefetchCache, type PrefetchCacheOptions } from './body-cache.js'

const NOT_FOUND = 'No resource with given identifier found'

/** A resolver pair so a test can settle a fetch promise on demand. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

/** sizeOf treats the cached string value as its own character length. */
function makeCache(opts: PrefetchCacheOptions = {}) {
  return new PrefetchCache<string>((v) => v.length, opts)
}

describe('PrefetchCache — resolve semantics', () => {
  it('resolves lookup with the value the primed fetch settles', async () => {
    const cache = makeCache()
    cache.prime('a', () => Promise.resolve('hello'))
    await expect(cache.lookup('a')).resolves.toBe('hello')
  })

  it('rejects lookup for an id that was never primed', async () => {
    const cache = makeCache()
    await expect(cache.lookup('ghost')).rejects.toThrow(NOT_FOUND)
  })

  it('does not resolve lookup until the pending fetch settles (no race)', async () => {
    const cache = makeCache()
    const { promise, resolve } = deferred<string>()
    cache.prime('a', () => promise)

    let settled = false
    const lookup = cache.lookup('a').then((v) => { settled = true; return v })
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)

    resolve('late-value')
    await expect(lookup).resolves.toBe('late-value')
    expect(settled).toBe(true)
  })
})

describe('PrefetchCache — idempotent priming', () => {
  it('ignores a second prime call while the first fetch is still pending', async () => {
    const cache = makeCache()
    const first = vi.fn(() => Promise.resolve('first'))
    const second = vi.fn(() => Promise.resolve('second'))
    cache.prime('a', first)
    cache.prime('a', second) // no-op: 'a' already has a pending entry

    await expect(cache.lookup('a')).resolves.toBe('first')
    expect(second).not.toHaveBeenCalled()
  })

  it('ignores a prime call once the id already has a settled entry', async () => {
    const cache = makeCache()
    cache.prime('a', () => Promise.resolve('first'))
    await cache.lookup('a')

    const second = vi.fn(() => Promise.resolve('second'))
    cache.prime('a', second)

    await expect(cache.lookup('a')).resolves.toBe('first')
    expect(second).not.toHaveBeenCalled()
  })
})

describe('PrefetchCache — error sentinels', () => {
  it('turns a fetch rejection into an error sentinel reported as not-found', async () => {
    const cache = makeCache()
    cache.prime('a', () => Promise.reject(new Error('debugger says no')))
    await expect(cache.lookup('a')).rejects.toThrow(NOT_FOUND)
  })

  it('turns an oversized resolved value into an error sentinel instead of caching it', async () => {
    const cache = makeCache({ perEntryMaxChars: 4 })
    cache.prime('a', () => Promise.resolve('way too long'))
    await expect(cache.lookup('a')).rejects.toThrow(NOT_FOUND)
  })
})

describe('PrefetchCache — TTL expiry (lazy, anchored to settle time)', () => {
  it('serves a value within its TTL window', async () => {
    let t = 0
    const cache = makeCache({ ttlMs: 1000, now: () => t })
    cache.prime('a', () => Promise.resolve('v'))
    await cache.lookup('a')
    t = 999
    await expect(cache.lookup('a')).resolves.toBe('v')
  })

  it('expires a settled entry once its TTL has elapsed, checked lazily on lookup', async () => {
    let t = 0
    const cache = makeCache({ ttlMs: 1000, now: () => t })
    cache.prime('a', () => Promise.resolve('v'))
    await cache.lookup('a')
    t = 1001
    await expect(cache.lookup('a')).rejects.toThrow(NOT_FOUND)
  })

  it('measures TTL from the settle time, not the prime() call time', async () => {
    let t = 0
    const cache = makeCache({ ttlMs: 1000, now: () => t })
    const { promise, resolve } = deferred<string>()
    cache.prime('a', () => promise) // call happens at t=0

    t = 5000 // the fetch takes a long time to settle
    resolve('slow-value')
    await Promise.resolve()
    await Promise.resolve()

    t = 5000 + 999 // inside the TTL measured FROM settle (5000), not from the call (0)
    await expect(cache.lookup('a')).resolves.toBe('slow-value')

    t = 5000 + 1001
    await expect(cache.lookup('a')).rejects.toThrow(NOT_FOUND)
  })
})

describe('PrefetchCache — LRU eviction (maxEntries)', () => {
  it('evicts the oldest settled entry once maxEntries is exceeded', async () => {
    const cache = makeCache({ maxEntries: 2 })
    cache.prime('a', () => Promise.resolve('A')); await cache.lookup('a')
    cache.prime('b', () => Promise.resolve('B')); await cache.lookup('b')
    cache.prime('c', () => Promise.resolve('C')); await cache.lookup('c')

    await expect(cache.lookup('a')).rejects.toThrow(NOT_FOUND) // oldest, evicted
    await expect(cache.lookup('b')).resolves.toBe('B')
    await expect(cache.lookup('c')).resolves.toBe('C')
  })

  it('a lookup hit refreshes recency, protecting the entry from the next eviction', async () => {
    const cache = makeCache({ maxEntries: 2 })
    cache.prime('a', () => Promise.resolve('A')); await cache.lookup('a')
    cache.prime('b', () => Promise.resolve('B')); await cache.lookup('b')

    await cache.lookup('a') // refresh 'a' — 'b' becomes the oldest

    cache.prime('c', () => Promise.resolve('C')); await cache.lookup('c')

    await expect(cache.lookup('a')).resolves.toBe('A')
    await expect(cache.lookup('b')).rejects.toThrow(NOT_FOUND)
    await expect(cache.lookup('c')).resolves.toBe('C')
  })
})

describe('PrefetchCache — size-based eviction (maxTotalChars)', () => {
  it('evicts the oldest entries once the total cached size exceeds maxTotalChars', async () => {
    const cache = makeCache({ maxEntries: 100, maxTotalChars: 10, perEntryMaxChars: 100 })
    cache.prime('a', () => Promise.resolve('12345')); await cache.lookup('a') // 5 chars
    cache.prime('b', () => Promise.resolve('12345')); await cache.lookup('b') // 5 chars, total 10 (at cap)
    cache.prime('c', () => Promise.resolve('123')); await cache.lookup('c') // pushes past cap

    await expect(cache.lookup('a')).rejects.toThrow(NOT_FOUND) // oldest evicted to make room
    await expect(cache.lookup('b')).resolves.toBe('12345')
    await expect(cache.lookup('c')).resolves.toBe('123')
  })
})

describe('PrefetchCache — pending entries are eviction-exempt', () => {
  it('never evicts a pending entry to make room, even under a tight maxEntries cap', async () => {
    const cache = makeCache({ maxEntries: 1 })
    const { promise, resolve } = deferred<string>()
    cache.prime('p', () => promise) // stays pending through the churn below

    cache.prime('a', () => Promise.resolve('A')); await cache.lookup('a')
    cache.prime('b', () => Promise.resolve('B')); await cache.lookup('b')

    resolve('P')
    await expect(cache.lookup('p')).resolves.toBe('P')
  })
})

describe('PrefetchCache — clear()', () => {
  it('drops all entries; subsequent lookups report not-found', async () => {
    const cache = makeCache()
    cache.prime('a', () => Promise.resolve('A'))
    await cache.lookup('a')

    cache.clear()

    await expect(cache.lookup('a')).rejects.toThrow(NOT_FOUND)
    expect(cache.size).toBe(0)
  })
})

describe('PrefetchCache — size', () => {
  it('reflects the current entry count across prime, eviction, and clear', async () => {
    const cache = makeCache({ maxEntries: 2 })
    expect(cache.size).toBe(0)

    cache.prime('a', () => Promise.resolve('A')); await cache.lookup('a')
    expect(cache.size).toBe(1)

    cache.prime('b', () => Promise.resolve('B')); await cache.lookup('b')
    expect(cache.size).toBe(2)

    cache.prime('c', () => Promise.resolve('C')); await cache.lookup('c') // evicts 'a'
    expect(cache.size).toBe(2)

    cache.clear()
    expect(cache.size).toBe(0)
  })
})
