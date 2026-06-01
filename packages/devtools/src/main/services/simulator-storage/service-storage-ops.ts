/**
 * service-storage-ops — localStorage primitives executed INSIDE the service-host
 * window (`wc`) via `executeJavaScript`, plus the wx-storage value encode/decode
 * pair.
 *
 * Under native-host the mini-app's storage lives on the service-host window's
 * `file://` origin (sync APIs write there via sync-impls/storage.ts, and the
 * unified async path routes there too). The Storage panel + the async-storage
 * runtime both read/write through here so there is exactly ONE store.
 *
 * The key/value scheme stays byte-compatible with
 * `src/service-host/sync-impls/storage.ts` (the authoritative wx storage impl):
 *   - key   = `${appId}_${key}`
 *   - value = `typeof data === 'object' ? JSON.stringify(data) : String(data)`
 *   - scoped clear removes every key whose name startsWith `${appId}_`
 *
 * Args are embedded via JSON.stringify so special characters can't break out of
 * the injected code. Reads tolerate failure (→ []/null); writes propagate so the
 * caller can fail the wx callback / surface the panel error.
 */
import type { WebContents } from 'electron'

/** Encode a wx storage value to its localStorage string form. Matches sync-impls/storage.ts. */
export function encodeStorageValue(data: unknown): string {
  return typeof data === 'object' ? JSON.stringify(data) : String(data)
}

/** Decode a localStorage string back to a value (JSON.parse, falling back to the raw string). */
export function decodeStorageValue(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return raw
  }
}

export interface ServiceStorage {
  /** All [fullKey, value] entries whose key startsWith `prefix`. */
  readAll(prefix: string): Promise<Array<[string, string]>>
  /** Raw value for a full (already-prefixed) key, or null if absent. */
  readOne(fullKey: string): Promise<string | null>
  writeOne(fullKey: string, value: string): Promise<void>
  removeOne(fullKey: string): Promise<void>
  /** Remove every key whose name startsWith `prefix`. */
  clearPrefix(prefix: string): Promise<void>
  /** Origin-wide localStorage.clear(). */
  clearAll(): Promise<void>
}

/** localStorage ops executed inside `wc` (the service-host window) via executeJavaScript. */
export function serviceStorage(wc: WebContents): ServiceStorage {
  return {
    async readAll(prefix) {
      const code = `(() => {
        const out = []
        const p = ${JSON.stringify(prefix)}
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i)
          if (k && k.startsWith(p)) out.push([k, localStorage.getItem(k)])
        }
        return out
      })()`
      try {
        const result = await wc.executeJavaScript(code)
        return Array.isArray(result) ? (result as Array<[string, string]>) : []
      } catch {
        return []
      }
    },
    async readOne(fullKey) {
      try {
        const result = await wc.executeJavaScript(`localStorage.getItem(${JSON.stringify(fullKey)})`)
        return result === null || result === undefined ? null : String(result)
      } catch {
        return null
      }
    },
    async writeOne(fullKey, value) {
      await wc.executeJavaScript(
        `localStorage.setItem(${JSON.stringify(fullKey)}, ${JSON.stringify(value)})`,
      )
    },
    async removeOne(fullKey) {
      await wc.executeJavaScript(`localStorage.removeItem(${JSON.stringify(fullKey)})`)
    },
    async clearPrefix(prefix) {
      const code = `(() => {
        const p = ${JSON.stringify(prefix)}
        const doomed = []
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i)
          if (k && k.startsWith(p)) doomed.push(k)
        }
        doomed.forEach((k) => localStorage.removeItem(k))
      })()`
      await wc.executeJavaScript(code)
    },
    async clearAll() {
      await wc.executeJavaScript('localStorage.clear()')
    },
  }
}
