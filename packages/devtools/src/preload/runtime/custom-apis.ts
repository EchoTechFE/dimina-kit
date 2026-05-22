import { ipcRenderer, type IpcRendererEvent } from 'electron'
import { SimulatorCustomApiBridgeChannel } from '../../shared/ipc-channels.js'
import { exposeOnMainWorld } from '../shared/expose.js'

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

/**
 * Re-send interval and ceiling for `list()` (see `listWithRetry`).
 *
 * The simulator boots fast enough that `__diminaCustomApis.list()` can fire
 * its `sendToHost` request *before* the embedding main-window renderer has
 * attached its `ipc-message` proxy listener (`useCustomApiProxy`). `sendToHost`
 * is fire-and-forget — a request sent into that gap is lost, and the bridge
 * call would otherwise hang until `custom-api-boot.ts`'s 3s deadlock-breaker.
 *
 * `list` is an idempotent read, so it is safe to re-send until a response
 * arrives. The retry resolves within one embedder attach cycle (~200ms) in
 * practice; the ceiling only bounds the leak if the proxy never attaches at
 * all, and is kept below `custom-api-boot.ts`'s `CUSTOM_API_LIST_TIMEOUT_MS`
 * so the retry exhausts before — not after — that outer timeout would fire.
 */
const LIST_RETRY_INTERVAL_MS = 150
const LIST_RETRY_CEILING_MS = 2500

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

  /**
   * `list()` with re-send, to survive the embedder proxy attaching after the
   * first request (see `LIST_RETRY_INTERVAL_MS`). Each attempt uses a fresh id
   * and its own `pending` entry; whichever response lands first settles the
   * call. Stale entries for the other attempts are dropped so a late duplicate
   * response cannot resolve nothing — or, worse, leak.
   */
  const listWithRetry = (): Promise<string[]> => {
    return new Promise<string[]>((resolve, reject) => {
      const attemptIds = new Set<number>()
      // Boxed so `cleanup` (defined before the timers are created) can clear
      // them; the box itself is `const`, only its fields are assigned later.
      const state: {
        settled: boolean
        retryTimer?: ReturnType<typeof setInterval>
        ceilingTimer?: ReturnType<typeof setTimeout>
      } = { settled: false }

      const cleanup = (): void => {
        state.settled = true
        if (state.retryTimer) clearInterval(state.retryTimer)
        if (state.ceilingTimer) clearTimeout(state.ceilingTimer)
        for (const id of attemptIds) pending.delete(id)
        attemptIds.clear()
      }

      const attempt = (): void => {
        if (state.settled) return
        const id = nextId++
        attemptIds.add(id)
        pending.set(id, {
          resolve: (value) => {
            if (state.settled) return
            cleanup()
            resolve(value as string[])
          },
          reject: (reason) => {
            if (state.settled) return
            cleanup()
            reject(reason)
          },
        })
        ipcRenderer.sendToHost(SimulatorCustomApiBridgeChannel.Request, { id, op: 'list' })
      }

      state.retryTimer = setInterval(attempt, LIST_RETRY_INTERVAL_MS)
      state.ceilingTimer = setTimeout(() => {
        if (state.settled) return
        cleanup()
        reject(new Error('custom-apis bridge list() got no response from the host renderer'))
      }, LIST_RETRY_CEILING_MS)
      attempt()
    })
  }

  return {
    list: listWithRetry,
    invoke: (name, params) => send<unknown>({ id: nextId++, op: 'invoke', name, params }),
  }
}

export function installCustomApisBridge(): () => void {
  const bridge = buildBridge()
  return exposeOnMainWorld('__diminaCustomApis', bridge)
}
