import { ipcRenderer } from 'electron'
import { CHANNELS } from '../shared/channels.js'

type MessageHandler = (msg: unknown) => void

const params = new URLSearchParams(globalThis.location?.search || '')
const bridgeId = params.get('bridgeId')
const pendingMessages: unknown[] = []
let onMessageFn: MessageHandler | null = null

if (!bridgeId) {
  throw new Error('[service-host] missing bridgeId in URL query')
}

Object.defineProperty(globalThis, '__diminaSpawnContext', {
  value: {
    bridgeId,
    appId: params.get('appId'),
    pagePath: params.get('pagePath'),
  },
  enumerable: false,
  configurable: false,
})

Object.defineProperty(globalThis, 'DiminaServiceBridge', {
  value: {
    get onMessage() {
      return onMessageFn
    },
    set onMessage(handler: MessageHandler | null) {
      onMessageFn = handler
      while (onMessageFn && pendingMessages.length > 0) {
        onMessageFn(pendingMessages.shift())
      }
    },
    invoke(msg: unknown) {
      console.log('[service-host] invoke', msg)
      ipcRenderer.send(CHANNELS.SERVICE_INVOKE, { bridgeId, msg })
      return undefined
    },
    publish(targetBridgeId: string, msg: unknown) {
      console.log('[service-host] publish', targetBridgeId, msg)
      ipcRenderer.send(CHANNELS.SERVICE_PUBLISH, { bridgeId, targetBridgeId, msg })
    },
  },
  writable: false,
  configurable: false,
})

ipcRenderer.on(CHANNELS.TO_SERVICE, (_event, payload: { msg: unknown }) => {
  if (onMessageFn) {
    onMessageFn(payload.msg)
    return
  }
  pendingMessages.push(payload.msg)
})
