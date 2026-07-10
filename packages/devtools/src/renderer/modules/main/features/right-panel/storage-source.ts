// Electron-IPC implementation of the shared StoragePanelSource contract: the
// Storage panel's data wiring lives in @dimina-kit/inspect
// (ConnectedStoragePanel); this host only says how the operations travel —
// over the renderer's single ipc-transport touchpoint to the main-process
// simulator-storage service.
import { invoke as ipcInvoke, on as ipcOn } from '@/shared/api/ipc-transport'
import { SimulatorStorageChannel } from '../../../../../shared/ipc-channels'
import type {
  StorageEvent,
  StorageItem,
  StoragePanelSource,
  StorageWriteResult,
} from '@dimina-kit/inspect'

const IPC_FAILED: StorageWriteResult = { ok: false, error: 'ipc transport failed' }

export function createIpcStoragePanelSource(): StoragePanelSource {
  return {
    getSnapshot: async () =>
      (await ipcInvoke<StorageItem[] | undefined>(SimulatorStorageChannel.GetSnapshot)) ?? [],
    subscribe: onEvent => ipcOn<[StorageEvent]>(SimulatorStorageChannel.Event, onEvent),
    // The main-process change feed (CDP DOMStorage + storageChanged synthetic
    // events) is always armed once the simulator exists — there is nothing to
    // gate per panel visibility on this host.
    setActive: () => {},
    setItem: async (key, value) =>
      (await ipcInvoke<StorageWriteResult | undefined>(SimulatorStorageChannel.Set, { key, value })) ?? IPC_FAILED,
    removeItem: async key =>
      (await ipcInvoke<StorageWriteResult | undefined>(SimulatorStorageChannel.Remove, { key })) ?? IPC_FAILED,
    clear: async () =>
      (await ipcInvoke<StorageWriteResult | undefined>(SimulatorStorageChannel.Clear)) ?? IPC_FAILED,
    // The simulator partition holds nothing but mini-program storage, so the
    // origin-wide wipe is a real capability here (unlike hosts sharing their
    // localStorage with workbench state).
    clearAll: async () =>
      (await ipcInvoke<StorageWriteResult | undefined>(SimulatorStorageChannel.ClearAll)) ?? IPC_FAILED,
    getPrefix: async () =>
      (await ipcInvoke<string | undefined>(SimulatorStorageChannel.GetActivePrefix)) ?? '',
  }
}
