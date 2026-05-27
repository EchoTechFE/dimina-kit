import { ipcRenderer } from 'electron'
import { CHANNELS } from '../shared/channels.js'

type MessageHandler = (msg: unknown) => void

const params = new URLSearchParams(globalThis.location?.search || '')
const bridgeId = params.get('bridgeId')
const pagePath = params.get('pagePath') || 'pages/index/index'
const pendingMessages: unknown[] = []
let onMessageFn: MessageHandler | null = null

if (!bridgeId) {
  throw new Error('[render-host] missing bridgeId in URL query')
}

Object.defineProperty(globalThis, 'DiminaRenderBridge', {
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
    invoke(rawMsg: string | unknown) {
      const msg = typeof rawMsg === 'string' ? JSON.parse(rawMsg) : rawMsg
      console.log('[render-host] invoke', msg)
      ipcRenderer.send(CHANNELS.RENDER_INVOKE, { bridgeId, msg })
    },
    publish(rawMsg: string | unknown) {
      const msg = typeof rawMsg === 'string' ? JSON.parse(rawMsg) : rawMsg
      console.log('[render-host] publish', msg)
      ipcRenderer.send(CHANNELS.RENDER_PUBLISH, { bridgeId, msg })
    },
  },
  writable: false,
  configurable: false,
})

ipcRenderer.on(CHANNELS.TO_RENDER, (_event, payload: { msg: unknown }) => {
  if (onMessageFn) {
    onMessageFn(payload.msg)
    return
  }
  pendingMessages.push(payload.msg)
})

globalThis.addEventListener('DOMContentLoaded', () => {
  ipcRenderer.send(CHANNELS.RENDER_INVOKE, {
    bridgeId,
    msg: {
      type: 'renderHostReady',
      target: 'container',
      body: { bridgeId, pagePath },
    },
  })
})
