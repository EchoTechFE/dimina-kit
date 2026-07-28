/**
 * applyAppDataSetData: service-host-side apply of a renderer AppData panel edit.
 *
 * Locates the page instance owning `bridgeId` via `getCurrentPages()` (the
 * dimina runtime global available inside the service-host window's execution
 * context) and calls `page.setData(data)` on it — the same entry point the
 * runtime's own `wx.Page` setData uses, so an edit from the panel re-renders
 * through the normal reactive path. Never throws: a malformed global, a
 * missing/mismatched page, or `setData` itself throwing all resolve to
 * `false` rather than propagating into the service-host's global scope.
 *
 * `./appdata-set-data.cjs` does not exist yet — this `require` is expected to
 * fail with a module-not-found error, which fails the whole suite; that
 * failure IS the "not implemented yet" signal this file guards.
 */
import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { applyAppDataSetData } = require('./appdata-set-data.cjs') as {
  applyAppDataSetData: (
    getCurrentPages: unknown,
    bridgeId: string,
    data: Record<string, unknown>,
  ) => boolean
}

interface FakePage {
  bridgeId: string
  setData?: unknown
}

function page(bridgeId: string, setData: FakePage['setData']): FakePage {
  return { bridgeId, setData }
}

describe('applyAppDataSetData', () => {
  it('returns false when getCurrentPages is not a function', () => {
    expect(applyAppDataSetData(undefined, 'b1', { a: 1 })).toBe(false)
    expect(applyAppDataSetData('not-a-function', 'b1', { a: 1 })).toBe(false)
  })

  it('returns false (not throw) when getCurrentPages() throws', () => {
    const throwing = () => {
      throw new Error('boom')
    }
    expect(() => applyAppDataSetData(throwing, 'b1', { a: 1 })).not.toThrow()
    expect(applyAppDataSetData(throwing, 'b1', { a: 1 })).toBe(false)
  })

  it('returns false when no page in the list matches bridgeId', () => {
    const getCurrentPages = () => [page('other', vi.fn())]
    expect(applyAppDataSetData(getCurrentPages, 'b1', { a: 1 })).toBe(false)
  })

  it("returns false when the matched page's setData is not a function", () => {
    const getCurrentPages = () => [page('b1', undefined)]
    expect(applyAppDataSetData(getCurrentPages, 'b1', { a: 1 })).toBe(false)
  })

  it('calls setData(data) on the matched page and returns true', () => {
    const setData = vi.fn()
    const getCurrentPages = () => [page('other', vi.fn()), page('b1', setData)]

    const result = applyAppDataSetData(getCurrentPages, 'b1', { count: 3 })

    expect(setData).toHaveBeenCalledWith({ count: 3 })
    expect(result).toBe(true)
  })

  it("returns false (not throw) when the matched page's setData throws", () => {
    const setData = () => {
      throw new Error('setData exploded')
    }
    const getCurrentPages = () => [page('b1', setData)]

    expect(() => applyAppDataSetData(getCurrentPages, 'b1', { count: 3 })).not.toThrow()
    expect(applyAppDataSetData(getCurrentPages, 'b1', { count: 3 })).toBe(false)
  })
})
