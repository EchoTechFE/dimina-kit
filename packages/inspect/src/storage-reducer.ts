import type { StorageEvent, StorageItem } from './storage-types.js'

/**
 * Applies one incremental StorageEvent to an item list, pure-function style
 * (the input array is never mutated; a new array is always returned).
 * `added` and `updated` are both tolerant upserts — host change feeds can
 * deliver them out of order (an `updated` may arrive before its `added`, or
 * an `added` may repeat for an existing key), and the reducer must converge
 * on the same list either way instead of duplicating keys or dropping data.
 */
export function applyStorageEvent(items: readonly StorageItem[], evt: StorageEvent): StorageItem[] {
  switch (evt.type) {
    case 'added':
    case 'updated': {
      const idx = items.findIndex(it => it.key === evt.key)
      if (idx < 0) return [...items, { key: evt.key, value: evt.newValue }]
      const next = [...items]
      next[idx] = { key: evt.key, value: evt.newValue }
      return next
    }
    case 'removed':
      return items.filter(it => it.key !== evt.key)
    case 'cleared':
      return []
  }
}
