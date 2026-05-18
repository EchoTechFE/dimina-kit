import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { SimulatorCustomApiBridgeChannel } from '../../shared/ipc-channels.js'

export interface DiminaCustomApisBridge {
  list(): Promise<string[]>
  invoke(name: string, params: unknown): Promise<unknown>
}

type BridgeRequest =
  | { id: number; op: 'list' }
  | { id: number; op: 'invoke'; name: string; params: unknown }

type BridgeResponse =
  | { id: number; result: unknown }
  | { id: number; error: string }

interface Pending {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
}

// The simulator <webview> is intentionally kept off the workbench sender-policy
// white-list, so it cannot reach `ipcMain.handle` directly. Instead the bridge
// asks the trusted main-window renderer to proxy the call: webview sends via
// `ipcRenderer.sendToHost`, host does the `ipcInvoke`, and posts the result
// back through `<webview>.send`. Requests and responses are correlated by id
// so concurrent invokes do not tangle.
function buildBridge(): DiminaCustomApisBridge {
  let nextId = 1
  const pending = new Map<number, Pending>()

  ipcRenderer.on(SimulatorCustomApiBridgeChannel.Response, (_event: IpcRendererEvent, payload: BridgeResponse) => {
    const entry = pending.get(payload.id)
    if (!entry) return
    pending.delete(payload.id)
    if ('error' in payload) {
      entry.reject(new Error(payload.error))
    } else {
      entry.resolve(payload.result)
    }
  })

  const send = <T>(req: BridgeRequest): Promise<T> => {
    return new Promise<T>((resolve, reject) => {
      pending.set(req.id, {
        resolve: (value) => resolve(value as T),
        reject,
      })
      ipcRenderer.sendToHost(SimulatorCustomApiBridgeChannel.Request, req)
    })
  }

  return {
    list: () => send<string[]>({ id: nextId++, op: 'list' }),
    invoke: (name, params) => send<unknown>({ id: nextId++, op: 'invoke', name, params }),
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
