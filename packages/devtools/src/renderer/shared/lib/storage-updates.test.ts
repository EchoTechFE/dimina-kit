import { describe, it, expect } from 'vitest'
import { applyStorageUpdate } from './storage-updates'

describe('applyStorageUpdate', () => {
  it('adds new item on set action', () => {
    const prev: Array<{ key: string; value: unknown }> = []
    const result = applyStorageUpdate(prev, {
      action: 'set',
      key: 'foo',
      value: 'bar',
    })
    expect(result).toEqual([{ key: 'foo', value: 'bar' }])
  })

  it('updates existing item on set action', () => {
    const prev = [
      { key: 'foo', value: 'old' },
      { key: 'baz', value: 'qux' },
    ]
    const result = applyStorageUpdate(prev, {
      action: 'set',
      key: 'foo',
      value: 'new',
    })
    expect(result).toEqual([
      { key: 'foo', value: 'new' },
      { key: 'baz', value: 'qux' },
    ])
  })

  it('removes item on remove action', () => {
    const prev = [
      { key: 'foo', value: 'bar' },
      { key: 'baz', value: 'qux' },
    ]
    const result = applyStorageUpdate(prev, {
      action: 'remove',
      key: 'foo',
    })
    expect(result).toEqual([{ key: 'baz', value: 'qux' }])
  })

  it('returns prev unchanged for unknown action', () => {
    const prev = [{ key: 'foo', value: 'bar' }]
    const result = applyStorageUpdate(prev, { action: 'unknown' })
    expect(result).toBe(prev)
  })

  it('returns prev unchanged for remove without key', () => {
    const prev = [{ key: 'foo', value: 'bar' }]
    const result = applyStorageUpdate(prev, { action: 'remove' })
    expect(result).toBe(prev)
  })

  it('clears all items on clear action', () => {
    const prev = [
      { key: 'foo', value: 'bar' },
      { key: 'baz', value: 'qux' },
    ]
    const result = applyStorageUpdate(prev, { action: 'clear' })
    expect(result).toEqual([])
  })

  it('clear on empty array returns empty array', () => {
    const result = applyStorageUpdate([], { action: 'clear' })
    expect(result).toEqual([])
  })
})
