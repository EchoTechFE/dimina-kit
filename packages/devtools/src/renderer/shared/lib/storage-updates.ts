export interface StorageMessage {
  action: string
  key?: string
  value?: string
}

export interface StorageItem {
  key: string
  value: unknown
}

/**
 * Apply incremental storage update to items array.
 * Pure function for easy testing.
 */
export function applyStorageUpdate(
  prev: StorageItem[],
  msg: StorageMessage
): StorageItem[] {
  if (msg.action === 'clear') {
    return []
  }
  if (msg.action === 'set' && msg.key !== undefined) {
    const idx = prev.findIndex((i) => i.key === msg.key)
    if (idx >= 0) {
      const next = [...prev]
      next[idx] = { key: msg.key, value: msg.value }
      return next
    }
    return [...prev, { key: msg.key, value: msg.value }]
  }
  if (msg.action === 'remove' && msg.key) {
    return prev.filter((i) => i.key !== msg.key)
  }
  return prev
}
