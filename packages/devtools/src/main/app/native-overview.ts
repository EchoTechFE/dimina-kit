import type { AppDataTap } from '../services/simulator-appdata/index.js'
import type { StorageApi } from '../services/simulator-storage/index.js'

/**
 * Narrow view of the fields the native overview provider reads. Depending on
 * this instead of the full `WorkbenchContext` grab-bag keeps this module out
 * of the workbench-context import ratchet.
 */
export interface NativeOverviewContext {
  storageApi?: StorageApi
  appData?: AppDataTap
}

/**
 * Best-effort native storage summary for `appId`. Any failure, or a
 * malformed `getStorageInfo` response, leaves the caller with empty
 * defaults rather than throwing.
 */
export async function resolveNativeStorageOverview(
  context: NativeOverviewContext,
  appId: string,
): Promise<{ storageKeys: string[]; storageCount: number }> {
  try {
    const info = await context.storageApi?.invoke(appId, 'getStorageInfo', {})
    if (info && typeof info === 'object') {
      const keys = (info as { keys?: unknown }).keys
      if (Array.isArray(keys)) {
        return {
          storageKeys: keys.filter((key): key is string => typeof key === 'string'),
          storageCount: keys.length,
        }
      }
    }
  } catch {
    // Leave native storage empty when it is temporarily unavailable.
  }
  return { storageKeys: [], storageCount: 0 }
}

/**
 * Best-effort appData key list for `appId`. Any failure, or a snapshot
 * without an `entries` object, resolves to an empty list rather than
 * throwing.
 */
export function resolveNativeAppDataKeys(context: NativeOverviewContext, appId: string): string[] {
  try {
    const snapshot = context.appData?.snapshot?.(appId)
    if (snapshot && typeof snapshot === 'object') {
      const entries = (snapshot as { entries?: unknown }).entries
      if (entries && typeof entries === 'object') {
        return Object.keys(entries)
      }
    }
  } catch {
    // Leave native appdata empty when it has not been initialized yet.
  }
  return []
}
