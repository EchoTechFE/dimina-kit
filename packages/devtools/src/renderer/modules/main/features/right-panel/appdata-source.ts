// Electron-IPC implementation of the shared AppDataPanelSource contract: the
// AppData panel's data wiring lives in @dimina-kit/inspect
// (ConnectedAppDataPanel); this host only says how the two operations
// travel — over the renderer's single ipc-transport touchpoint to the
// main-process simulator-appdata service.
import { invoke as ipcInvoke, on as ipcOn } from '@/shared/api/ipc-transport'
import { SimulatorAppDataChannel } from '../../../../../shared/ipc-channels'
import type { AppDataPanelSource, AppDataSnapshot } from '@dimina-kit/inspect'

const EMPTY_SNAPSHOT: AppDataSnapshot = { bridges: [], entries: {} }

export function createIpcAppDataPanelSource(): AppDataPanelSource {
  return {
    getSnapshot: async () =>
      (await ipcInvoke<AppDataSnapshot | undefined>(SimulatorAppDataChannel.GetSnapshot)) ?? EMPTY_SNAPSHOT,
    subscribe: onSnapshot => ipcOn<[AppDataSnapshot]>(SimulatorAppDataChannel.Event, onSnapshot),
    // The main-process appdata tap (bridge-router SERVICE_PUBLISH) stays armed
    // regardless of panel visibility — the automation mirror
    // (__simulatorData.getAppdata()) depends on it independent of any panel
    // being open, so there is no visibility gate to wire here.
    setActive: () => {},
  }
}
