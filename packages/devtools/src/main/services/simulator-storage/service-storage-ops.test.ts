/**
 * Behavior tests for service-storage-ops.
 *
 * Two halves:
 *   1. encodeStorageValue / decodeStorageValue — the wx storage value codec,
 *      byte-compatible with src/service-host/sync-impls/storage.ts:
 *        encode: typeof data === 'object' ? JSON.stringify(data) : String(data)
 *        decode: JSON.parse(raw), falling back to the raw string on parse error
 *   2. serviceStorage(wc) — localStorage primitives executed inside the
 *      service-host window via `executeJavaScript`. We assert the injected code
 *      contains the right localStorage call + JSON-encoded args (so the guest
 *      can't be tricked by special characters), and the read/write failure
 *      asymmetry:
 *        - reads (readAll/readOne) swallow rejection → [] / null
 *        - writes (writeOne/removeOne/clearPrefix/clearAll) PROPAGATE rejection
 *
 * Like render-inspect.test.ts, no electron mock is needed — the module only
 * type-imports electron and takes a FAKE WebContents.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  decodeStorageValue,
  encodeStorageValue,
  serviceStorage,
} from './service-storage-ops.js'

interface FakeWc {
  id: number
  isDestroyed: ReturnType<typeof vi.fn>
  executeJavaScript: ReturnType<typeof vi.fn>
  once: ReturnType<typeof vi.fn>
}

function makeWc(id = 1): FakeWc {
  return {
    id,
    isDestroyed: vi.fn(() => false),
    // Default resolves undefined; individual tests override with
    // mockResolvedValueOnce / mockRejectedValueOnce.
    executeJavaScript: vi.fn(async () => undefined),
    once: vi.fn(),
  }
}

function asWc(wc: FakeWc): import('electron').WebContents {
  return wc as unknown as import('electron').WebContents
}

/** Concatenate every executeJavaScript code argument into one string. */
function allCode(wc: FakeWc): string {
  return wc.executeJavaScript.mock.calls.map((c) => String(c[0])).join('\n')
}

// ────────────────────────────────────────────────────────────────────────────
// encodeStorageValue — mirrors sync-impls/storage.ts setStorageSync
// ────────────────────────────────────────────────────────────────────────────
describe('encodeStorageValue', () => {
  it('JSON.stringifies a plain object', () => {
    expect(encodeStorageValue({ a: 1 })).toBe('{"a":1}')
  })

  it('JSON.stringifies an array', () => {
    expect(encodeStorageValue([1, 2, 3])).toBe('[1,2,3]')
  })

  it('returns a string value as-is', () => {
    expect(encodeStorageValue('x')).toBe('x')
  })

  it('stringifies a number via String()', () => {
    expect(encodeStorageValue(5)).toBe('5')
  })

  it('stringifies a boolean via String()', () => {
    expect(encodeStorageValue(true)).toBe('true')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// decodeStorageValue — mirrors sync-impls/storage.ts getStorageSync
// ────────────────────────────────────────────────────────────────────────────
describe('decodeStorageValue', () => {
  it('JSON.parses an object string', () => {
    expect(decodeStorageValue('{"a":1}')).toEqual({ a: 1 })
  })

  it('JSON.parses a numeric string', () => {
    expect(decodeStorageValue('5')).toBe(5)
  })

  it('JSON.parses a boolean string', () => {
    expect(decodeStorageValue('true')).toBe(true)
  })

  it('falls back to the raw string for non-JSON', () => {
    expect(decodeStorageValue('hello')).toBe('hello')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// serviceStorage(wc).readAll — tolerant read
// ────────────────────────────────────────────────────────────────────────────
describe('serviceStorage — readAll', () => {
  it('runs ONE executeJavaScript with JSON.stringify(prefix) + localStorage, returns the guest array', async () => {
    const wc = makeWc()
    const entries: Array<[string, string]> = [
      ['wx123_a', '1'],
      ['wx123_b', '2'],
    ]
    wc.executeJavaScript.mockResolvedValueOnce(entries)

    const result = await serviceStorage(asWc(wc)).readAll('wx123_')

    expect(result).toEqual(entries)
    expect(wc.executeJavaScript).toHaveBeenCalledTimes(1)
    const code = allCode(wc)
    expect(code).toContain(JSON.stringify('wx123_'))
    expect(code).toContain('localStorage')
  })

  it('resolves [] (no throw) when executeJavaScript rejects', async () => {
    const wc = makeWc()
    wc.executeJavaScript.mockRejectedValueOnce(new Error('guest boom'))

    await expect(serviceStorage(asWc(wc)).readAll('wx123_')).resolves.toEqual([])
  })
})

// ────────────────────────────────────────────────────────────────────────────
// serviceStorage(wc).readOne — tolerant read
// ────────────────────────────────────────────────────────────────────────────
describe('serviceStorage — readOne', () => {
  it('code contains getItem + JSON.stringify(fullKey); returns the resolved string', async () => {
    const wc = makeWc()
    wc.executeJavaScript.mockResolvedValueOnce('the-value')

    const result = await serviceStorage(asWc(wc)).readOne('wx123_a')

    expect(result).toBe('the-value')
    const code = allCode(wc)
    expect(code).toContain('getItem')
    expect(code).toContain(JSON.stringify('wx123_a'))
  })

  it('returns null when the guest resolves null', async () => {
    const wc = makeWc()
    wc.executeJavaScript.mockResolvedValueOnce(null)

    await expect(serviceStorage(asWc(wc)).readOne('wx123_a')).resolves.toBeNull()
  })

  it('resolves null (no throw) when executeJavaScript rejects', async () => {
    const wc = makeWc()
    wc.executeJavaScript.mockRejectedValueOnce(new Error('guest boom'))

    await expect(serviceStorage(asWc(wc)).readOne('wx123_a')).resolves.toBeNull()
  })
})

// ────────────────────────────────────────────────────────────────────────────
// serviceStorage(wc).writeOne — explicit write (propagates rejection)
// ────────────────────────────────────────────────────────────────────────────
describe('serviceStorage — writeOne', () => {
  it('code contains setItem + JSON.stringify(fullKey) + JSON.stringify(value)', async () => {
    const wc = makeWc()

    await serviceStorage(asWc(wc)).writeOne('wx123_a', 'the-value')

    const code = allCode(wc)
    expect(code).toContain('setItem')
    expect(code).toContain(JSON.stringify('wx123_a'))
    expect(code).toContain(JSON.stringify('the-value'))
  })

  it('REJECTS (propagates) when executeJavaScript rejects', async () => {
    const wc = makeWc()
    wc.executeJavaScript.mockRejectedValueOnce(new Error('guest boom'))

    await expect(serviceStorage(asWc(wc)).writeOne('wx123_a', 'v')).rejects.toThrow()
  })
})

// ────────────────────────────────────────────────────────────────────────────
// serviceStorage(wc).removeOne — explicit write (propagates rejection)
// ────────────────────────────────────────────────────────────────────────────
describe('serviceStorage — removeOne', () => {
  it('code contains removeItem + JSON.stringify(fullKey)', async () => {
    const wc = makeWc()

    await serviceStorage(asWc(wc)).removeOne('wx123_a')

    const code = allCode(wc)
    expect(code).toContain('removeItem')
    expect(code).toContain(JSON.stringify('wx123_a'))
  })

  it('REJECTS (propagates) when executeJavaScript rejects', async () => {
    const wc = makeWc()
    wc.executeJavaScript.mockRejectedValueOnce(new Error('guest boom'))

    await expect(serviceStorage(asWc(wc)).removeOne('wx123_a')).rejects.toThrow()
  })
})

// ────────────────────────────────────────────────────────────────────────────
// serviceStorage(wc).clearPrefix — explicit write (propagates rejection)
// ────────────────────────────────────────────────────────────────────────────
describe('serviceStorage — clearPrefix', () => {
  it('code contains JSON.stringify(prefix) + removeItem (loops + removes prefixed keys)', async () => {
    const wc = makeWc()

    await serviceStorage(asWc(wc)).clearPrefix('wx123_')

    const code = allCode(wc)
    expect(code).toContain(JSON.stringify('wx123_'))
    expect(code).toContain('removeItem')
  })

  it('REJECTS (propagates) when executeJavaScript rejects', async () => {
    const wc = makeWc()
    wc.executeJavaScript.mockRejectedValueOnce(new Error('guest boom'))

    await expect(serviceStorage(asWc(wc)).clearPrefix('wx123_')).rejects.toThrow()
  })
})

// ────────────────────────────────────────────────────────────────────────────
// serviceStorage(wc).clearAll — explicit write (propagates rejection)
// ────────────────────────────────────────────────────────────────────────────
describe('serviceStorage — clearAll', () => {
  it('code contains localStorage.clear', async () => {
    const wc = makeWc()

    await serviceStorage(asWc(wc)).clearAll()

    expect(allCode(wc)).toContain('localStorage.clear')
  })

  it('REJECTS (propagates) when executeJavaScript rejects', async () => {
    const wc = makeWc()
    wc.executeJavaScript.mockRejectedValueOnce(new Error('guest boom'))

    await expect(serviceStorage(asWc(wc)).clearAll()).rejects.toThrow()
  })
})

// Keep `beforeEach` referenced for symmetry with sibling tests; vi auto-resets
// per the global config, so nothing extra is needed here.
beforeEach(() => {})
