// The host-transport contract behind the Storage panel: the panel's data
// wiring (seed, live event reduction, visibility gating, write forwarding)
// is written ONCE against this interface (see ConnectedStoragePanel); each
// host only implements how the operations travel — Electron IPC channels, a
// same-origin localStorage + `storage` events, or anything else.
import type { StorageEvent, StorageItem, StorageWriteResult } from './storage-types.js'

export interface StoragePanelSource {
  /** Fetch the current item snapshot (seed on panel activation). */
  getSnapshot(): Promise<StorageItem[]>
  /** Live mutation pushes; returns an unsubscribe function. */
  subscribe(onEvent: (evt: StorageEvent) => void): () => void
  /** Visibility gate: hosts whose change feed costs something (listeners,
   * polling) only keep it armed while some panel is visible. */
  setActive(on: boolean): void
  /** Write one entry. `key` carries the full `${appId}_` prefix. */
  setItem(key: string, value: string): Promise<StorageWriteResult>
  /** Remove one entry by full key. */
  removeItem(key: string): Promise<StorageWriteResult>
  /** Clear the active appId's entries only. */
  clear(): Promise<StorageWriteResult>
  /** Origin-wide wipe across every appId. Optional: hosts whose storage
   * partition is shared with non-mini-program data must not provide it, and
   * the panel then hides the「清空所有」action entirely. */
  clearAll?(): Promise<StorageWriteResult>
  /** The active appId namespace prefix (`${appId}_`), '' while unresolved. */
  getPrefix(): Promise<string>
}
