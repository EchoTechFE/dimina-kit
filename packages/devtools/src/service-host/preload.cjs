const { ipcRenderer } = require('electron')

const CHANNELS = {
  SERVICE_INVOKE: 'dmb:service:invoke',
  SERVICE_PUBLISH: 'dmb:service:publish',
  TO_SERVICE: 'dmb:to-service',
}

const params = new URLSearchParams(globalThis.location && globalThis.location.search || '')
const bridgeId = params.get('bridgeId')
const pendingMessages = []
let onMessageFn = null
let drainScheduled = false

if (!bridgeId) {
  throw new Error('[service-host] missing bridgeId in URL query')
}

function parseHostEnv() {
  const raw = params.get('hostEnv')
  if (!raw) return null
  try {
    return JSON.parse(decodeURIComponent(raw))
  } catch (error) {
    console.warn('[service-host] invalid hostEnv param', error)
    return null
  }
}

Object.defineProperty(globalThis, '__diminaSpawnContext', {
  value: {
    bridgeId,
    appId: params.get('appId') || '',
    pagePath: params.get('pagePath') || '',
    pkgRoot: params.get('pkgRoot') || '',
    resourceBaseUrl: params.get('resourceBaseUrl') || '',
    hostEnvSnapshot: parseHostEnv(),
  },
  enumerable: false,
  configurable: false,
})

function reportError(stage, error) {
  const message = error && error.stack ? error.stack : String(error)
  console.error(`[service-host] ${stage}`, error)
  ipcRenderer.send(CHANNELS.SERVICE_INVOKE, {
    bridgeId,
    msg: {
      type: 'serviceHostError',
      target: 'container',
      body: { stage, message },
    },
  })
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

Object.defineProperty(globalThis, 'DiminaServiceBridge', {
  value: {
    get onMessage() {
      return onMessageFn
    },
    set onMessage(handler) {
      onMessageFn = typeof handler === 'function' ? handler : null
      scheduleDrain()
    },
    invoke(msg) {
      ipcRenderer.send(CHANNELS.SERVICE_INVOKE, { bridgeId, msg })
      return undefined
    },
    publish(targetBridgeId, msg) {
      ipcRenderer.send(CHANNELS.SERVICE_PUBLISH, { bridgeId, targetBridgeId, msg })
    },
  },
  writable: false,
  configurable: false,
})

const block = (key) => Object.defineProperty(globalThis, key, {
  get() {
    throw new Error(`[service] ${key} not available in service context`)
  },
  configurable: false,
})
;['document', 'history', 'sessionStorage'].forEach(block)

ipcRenderer.on(CHANNELS.TO_SERVICE, (_event, payload) => {
  deliver(payload && payload.msg)
})
