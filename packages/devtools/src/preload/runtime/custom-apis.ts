import { contextBridge, ipcRenderer } from 'electron'
import { SimulatorCustomApiChannel } from '../../shared/ipc-channels.js'

export interface DiminaCustomApisBridge {
  list(): Promise<string[]>
  invoke(name: string, params: unknown): Promise<unknown>
}

function buildBridge(): DiminaCustomApisBridge {
  return {
    list: () => ipcRenderer.invoke(SimulatorCustomApiChannel.List),
    invoke: (name, params) => ipcRenderer.invoke(SimulatorCustomApiChannel.Invoke, name, params),
  }
}

export function installCustomApisBridge(): void {
  const bridge = buildBridge()
  try {
    contextBridge.exposeInMainWorld('__diminaCustomApis', bridge)
  } catch {
    (window as unknown as Record<string, unknown>).__diminaCustomApis = bridge
  }
}
