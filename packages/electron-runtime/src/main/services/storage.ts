import type { WebContents } from 'electron'
import {
  decodeStorageValue,
  encodeStorageValue,
  serviceStorage,
} from './service-storage-ops.js'

export interface RuntimeStorageApi {
  invoke(appId: string, name: string, params: Record<string, unknown>): Promise<unknown>
}

export const STORAGE_API_NAMES = new Set([
  'setStorage',
  'getStorage',
  'removeStorage',
  'clearStorage',
  'getStorageInfo',
])

export function createRuntimeStorageApi(
  getServiceWebContents: (appId: string) => WebContents | null,
): RuntimeStorageApi {
  return {
    async invoke(appId, name, params) {
      const wc = getServiceWebContents(appId)
      if (!wc) throw new Error('service-host window unavailable')
      const storage = serviceStorage(wc)
      const prefix = `${appId}_`
      const key = typeof params.key === 'string' ? params.key : ''
      const fullKey = prefix + key

      switch (name) {
        case 'setStorage':
          await storage.writeOne(fullKey, encodeStorageValue(params.data))
          return { errMsg: 'setStorage:ok' }
        case 'getStorage': {
          const raw = await storage.readOne(fullKey)
          if (raw === null) throw new Error('getStorage:fail data not found')
          return { data: decodeStorageValue(raw), errMsg: 'getStorage:ok' }
        }
        case 'removeStorage':
          await storage.removeOne(fullKey)
          return { errMsg: 'removeStorage:ok' }
        case 'clearStorage':
          await storage.clearPrefix(prefix)
          return { errMsg: 'clearStorage:ok' }
        case 'getStorageInfo': {
          const entries = await storage.readAll(prefix)
          const keys = entries.map(([entryKey]) => entryKey.slice(prefix.length))
          const currentSize = entries.reduce((size, [, value]) => size + value.length * 2, 0)
          return {
            keys,
            currentSize,
            limitSize: 10 * 1024 * 1024,
            errMsg: 'getStorageInfo:ok',
          }
        }
        default:
          throw new Error(`unsupported storage api ${name}`)
      }
    },
  }
}
