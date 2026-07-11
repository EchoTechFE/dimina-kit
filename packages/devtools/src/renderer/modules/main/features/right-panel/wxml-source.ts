// Electron-IPC implementation of the shared WxmlPanelSource contract: the
// WXML panel's data wiring lives in @dimina-kit/inspect
// (ConnectedWxmlPanel); this host only says how the five operations travel —
// over the renderer's single ipc-transport touchpoint to the main-process
// simulator-wxml / render-inspect services.
import { invoke as ipcInvoke, on as ipcOn } from '@/shared/api/ipc-transport'
import {
  SimulatorElementChannel,
  SimulatorWxmlChannel,
  type ElementInspection,
} from '../../../../../shared/ipc-channels'
import type { WxmlNode, WxmlPanelSource } from '@dimina-kit/inspect'

export function createIpcWxmlPanelSource(): WxmlPanelSource {
  return {
    getSnapshot: async () =>
      (await ipcInvoke<WxmlNode | null | undefined>(SimulatorWxmlChannel.GetSnapshot)) ?? null,
    subscribe: onTree => ipcOn<[WxmlNode | null]>(SimulatorWxmlChannel.Event, onTree),
    setActive: (on) => {
      void ipcInvoke<void>(SimulatorWxmlChannel.SetActive, on)
    },
    inspect: async sid =>
      (await ipcInvoke<ElementInspection | null | undefined>(SimulatorElementChannel.Inspect, sid)) ?? null,
    clearInspection: async () => {
      await ipcInvoke<void>(SimulatorElementChannel.Clear)
    },
  }
}
