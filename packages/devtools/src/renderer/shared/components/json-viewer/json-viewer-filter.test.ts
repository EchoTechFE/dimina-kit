/**
 * `filterJson` decides what the search box in JsonViewer actually shows:
 * a branch survives only if a key or a stringified primitive value contains
 * the (case-insensitive) query. These tests pin that contract so a future
 * refactor can't silently change which nodes match or drop ancestor paths.
 */
import { describe, expect, it } from 'vitest'
import { filterJson } from './json-viewer'

describe('filterJson — primitive matching', () => {
  it('keeps a primitive whose stringified form contains the query', () => {
    expect(filterJson('hello world', 'hello')).toBe('hello world')
    expect(filterJson(42, '4')).toBe(42)
  })

  it('drops a primitive that does not match', () => {
    expect(filterJson('hello world', 'zzz')).toBeUndefined()
    expect(filterJson(42, '9')).toBeUndefined()
  })

  it('is case-insensitive', () => {
    expect(filterJson('Beijing', 'BEIJING')).toBe('Beijing')
    expect(filterJson('Beijing', 'beijing')).toBe('Beijing')
  })

  it('treats null/undefined as never matching', () => {
    expect(filterJson(null, 'x')).toBeUndefined()
    expect(filterJson(undefined, 'x')).toBeUndefined()
  })
})

describe('filterJson — object key matching', () => {
  it('keeps a whole entry, unfiltered, when the key matches', () => {
    const data = { name: 'Alice', unrelated: 'nope' }
    expect(filterJson(data, 'name')).toEqual({ name: 'Alice' })
  })

  it('is case-insensitive for keys', () => {
    const data = { Name: 'Alice' }
    expect(filterJson(data, 'name')).toEqual({ Name: 'Alice' })
  })

  it('drops fields whose key and value both fail to match', () => {
    const data = { id: 1, name: 'foo' }
    // 'id' key/value ('1') don't contain 'foo'; only the 'name' value does.
    expect(filterJson(data, 'foo')).toEqual({ name: 'foo' })
  })

  it('returns undefined when no field matches at all', () => {
    expect(filterJson({ a: 1, b: 2 }, 'zzz')).toBeUndefined()
  })
})

describe('filterJson — nested matches keep the ancestor path', () => {
  it('keeps only the branch leading to a matching leaf value', () => {
    const data = {
      a: { b: { c: 'target' } },
      x: { y: 'other' },
    }
    expect(filterJson(data, 'target')).toEqual({ a: { b: { c: 'target' } } })
  })

  it('keeps the ancestor path when a descendant key matches', () => {
    const data = {
      a: { targetKey: 'x' },
      b: { other: 'y' },
    }
    expect(filterJson(data, 'target')).toEqual({ a: { targetKey: 'x' } })
  })
})

describe('filterJson — arrays', () => {
  it('keeps only elements whose filtered subtree is non-empty', () => {
    expect(filterJson([1, 2, 3], '2')).toEqual([2])
  })

  it('returns undefined when no array element matches', () => {
    expect(filterJson([1, 2, 3], '9')).toBeUndefined()
  })

  it('keeps the ancestor path for a match nested inside array items', () => {
    const data = {
      list: [{ meta: { label: 'wanted' } }, { meta: { label: 'other' } }],
    }
    expect(filterJson(data, 'wanted')).toEqual({
      list: [{ meta: { label: 'wanted' } }],
    })
  })
})

describe('filterJson — empty query', () => {
  it('matches every key trivially, keeping the full structure', () => {
    const data = { a: { b: 1 }, c: [1, 2] }
    expect(filterJson(data, '')).toEqual(data)
  })
})
