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

// ── Console capture (native-host) ───────────────────────────────────────────
// This preload runs with contextIsolation effectively off (it defines globals on
// globalThis the page reads), so patching `console` here captures the render
// guest's own console output. Each entry is forwarded to main as a `consoleLog`
// container message (source:'render') — bridge-router routes it to ctx.guestConsole
// → automation rebroadcasts it as App.logAdded. Mirrors the shape used by
// src/preload/instrumentation/console.ts + runtime/host.ts safeSerialize.

function safeSerializeArg(val) {
  if (val === null || val === undefined) return val
  if (typeof val === 'function') return `[Function: ${val.name || 'anonymous'}]`
  if (typeof val !== 'object') return val
  if (val instanceof Error) return { __isError: true, message: val.message, stack: val.stack }
  try {
    return structuredClone(val)
  } catch (_) { /* DOM nodes / proxies can't be structuredCloned */ }
  try {
    return JSON.parse(JSON.stringify(val))
  } catch (_) { /* circular / non-serializable */ }
  return String(val)
}

function emitConsoleLog(level, args) {
  try {
    globalThis.DiminaRenderBridge.invoke({
      type: 'consoleLog',
      target: 'container',
      body: {
        bridgeId,
        source: 'render',
        level,
        args: args.map(safeSerializeArg),
        ts: Date.now(),
      },
    })
  } catch (_) { /* never let console capture break the guest */ }
}

;['log', 'warn', 'error', 'info', 'debug'].forEach((level) => {
  const original = typeof console[level] === 'function' ? console[level].bind(console) : null
  if (!original) return
  console[level] = (...args) => {
    original(...args)
    emitConsoleLog(level, args)
  }
})

globalThis.addEventListener('error', (event) => {
  emitConsoleLog('error', [{
    message: event.message,
    source: event.filename,
    lineno: event.lineno,
    colno: event.colno,
    stack: event.error && event.error.stack,
  }])
})

globalThis.addEventListener('unhandledrejection', (event) => {
  emitConsoleLog('error', [{ message: 'Unhandled Promise Rejection', reason: String(event.reason) }])
})
