const { ipcRenderer } = require('electron')

const CHANNELS = {
  RENDER_INVOKE: 'dmb:render:invoke',
  RENDER_PUBLISH: 'dmb:render:publish',
  TO_RENDER: 'dmb:to-render',
}

const params = new URLSearchParams(globalThis.location && globalThis.location.search || '')
const bridgeId = params.get('bridgeId')
const pagePath = params.get('pagePath') || 'pages/index/index'
const pendingMessages = []
let onMessageFn = null
let drainScheduled = false

if (!bridgeId) {
  throw new Error('[render-host] missing bridgeId in URL query')
}

function reportError(stage, error) {
  const message = error && error.stack ? error.stack : String(error)
  console.error(`[render-host] ${stage}`, error)
  ipcRenderer.send(CHANNELS.RENDER_INVOKE, {
    bridgeId,
    msg: {
      type: 'componentError',
      target: 'container',
      body: { bridgeId, stage, message },
    },
  })
}

function parseMessage(rawMsg) {
  return typeof rawMsg === 'string' ? JSON.parse(rawMsg) : rawMsg
}

function deliver(msg) {
  if (!onMessageFn) {
    pendingMessages.push(msg)
    return
  }
  try {
    onMessageFn(msg)
  } catch (error) {
    reportError('onMessage', error)
  }
}

function scheduleDrain() {
  if (drainScheduled) return
  drainScheduled = true
  queueMicrotask(() => {
    drainScheduled = false
    while (onMessageFn && pendingMessages.length > 0) {
      deliver(pendingMessages.shift())
    }
  })
}

Object.defineProperty(globalThis, 'DiminaRenderBridge', {
  value: {
    get onMessage() {
      return onMessageFn
    },
    set onMessage(handler) {
      onMessageFn = typeof handler === 'function' ? handler : null
      scheduleDrain()
    },
    invoke(rawMsg) {
      ipcRenderer.send(CHANNELS.RENDER_INVOKE, { bridgeId, msg: parseMessage(rawMsg) })
    },
    publish(rawMsg) {
      ipcRenderer.send(CHANNELS.RENDER_PUBLISH, { bridgeId, msg: parseMessage(rawMsg) })
    },
  },
  writable: false,
  configurable: false,
})

ipcRenderer.on(CHANNELS.TO_RENDER, (_event, payload) => {
  deliver(payload && payload.msg)
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
