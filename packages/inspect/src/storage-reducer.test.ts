import { describe, expect, it } from 'vitest'
import { applyStorageEvent } from './storage-reducer.js'
import type { StorageEvent, StorageItem } from './storage-types.js'

describe('applyStorageEvent: added', () => {
  it('appends a new key to the end of the list', () => {
    const items: StorageItem[] = [{ key: 'a', value: '1' }]
    const result = applyStorageEvent(items, { type: 'added', key: 'b', newValue: '2' })
    expect(result).toEqual([{ key: 'a', value: '1' }, { key: 'b', value: '2' }])
  })

  it('replaces the value of an existing key in place instead of duplicating it', () => {
    const items: StorageItem[] = [{ key: 'a', value: '1' }, { key: 'b', value: '2' }]
    const result = applyStorageEvent(items, { type: 'added', key: 'a', newValue: '99' })
    expect(result).toEqual([{ key: 'a', value: '99' }, { key: 'b', value: '2' }])
  })
})

describe('applyStorageEvent: updated', () => {
  it('replaces the value of an existing key', () => {
    const items: StorageItem[] = [{ key: 'a', value: '1' }]
    const result = applyStorageEvent(items, { type: 'updated', key: 'a', oldValue: '1', newValue: '2' })
    expect(result).toEqual([{ key: 'a', value: '2' }])
  })

  it('appends the key when an updated event arrives before its added event', () => {
    const items: StorageItem[] = []
    const result = applyStorageEvent(items, { type: 'updated', key: 'a', oldValue: '', newValue: '2' })
    expect(result).toEqual([{ key: 'a', value: '2' }])
  })
})

describe('applyStorageEvent: removed', () => {
  it('drops the matching key', () => {
    const items: StorageItem[] = [{ key: 'a', value: '1' }, { key: 'b', value: '2' }]
    const result = applyStorageEvent(items, { type: 'removed', key: 'a' })
    expect(result).toEqual([{ key: 'b', value: '2' }])
  })

  it('returns the list unchanged in length when the key is absent', () => {
    const items: StorageItem[] = [{ key: 'a', value: '1' }]
    const result = applyStorageEvent(items, { type: 'removed', key: 'missing' })
    expect(result).toEqual(items)
    expect(result).toHaveLength(1)
  })
})

describe('applyStorageEvent: cleared', () => {
  it('returns an empty list regardless of prior contents', () => {
    const items: StorageItem[] = [{ key: 'a', value: '1' }, { key: 'b', value: '2' }]
    const result = applyStorageEvent(items, { type: 'cleared' })
    expect(result).toEqual([])
  })
})

describe('applyStorageEvent: purity', () => {
  it('never mutates the input array, for any event type', () => {
    const items: readonly StorageItem[] = Object.freeze([
      Object.freeze({ key: 'a', value: '1' }),
      Object.freeze({ key: 'b', value: '2' }),
    ])
    const events: StorageEvent[] = [
      { type: 'added', key: 'a', newValue: 'x' },
      { type: 'added', key: 'c', newValue: 'x' },
      { type: 'updated', key: 'a', oldValue: '1', newValue: 'x' },
      { type: 'removed', key: 'a' },
      { type: 'cleared' },
    ]
    for (const evt of events) {
      expect(() => applyStorageEvent(items, evt)).not.toThrow()
    }
    expect(items).toEqual([{ key: 'a', value: '1' }, { key: 'b', value: '2' }])
  })

  it('returns a new array reference distinct from the input', () => {
    const items: StorageItem[] = [{ key: 'a', value: '1' }]
    const result = applyStorageEvent(items, { type: 'added', key: 'b', newValue: '2' })
    expect(result).not.toBe(items)
  })
})
