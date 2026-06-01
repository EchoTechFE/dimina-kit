const { ipcRenderer } = require('electron')

const CHANNELS = {
  SERVICE_INVOKE: 'dmb:service:invoke',
  SERVICE_PUBLISH: 'dmb:service:publish',
  TO_SERVICE: 'dmb:to-service',
  // main → this window: live-update the host-env snapshot on a device change so
  // wx.getSystemInfoSync() reflects the newly-selected device without a
  // relaunch. Mirrors ServiceHostChannel.HostEnvUpdate in shared/ipc-channels.ts.
  HOST_ENV_UPDATE: 'service-host:host-env:update',
}

const params = new URLSearchParams(globalThis.location && globalThis.location.search || '')
const bridgeId = params.get('bridgeId')
const pendingMessages = []
let onMessageFn = null
let drainScheduled = false

if (!bridgeId) {
  // Warming idle: a pre-warm pool loads this preload against about:blank (no
  // bridgeId) just to fork the renderer + warm the V8 isolate. Defer all bridge
  // setup to the real spawn navigation (service.html?bridgeId=…), which re-runs
  // this preload with a bridgeId. Real spawns always carry one, so the spawn
  // path is unaffected.
  return
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

// Live host-env updates (native-host device dropdown). The binding above is
// non-configurable, but the inner object's properties are writable — merge the
// pushed metrics into `hostEnvSnapshot` in place. `sync-impls/system-info.ts`
// reads `this.hostEnvSnapshot` fresh on every `getSystemInfoSync()`, so the
// next call (and the mini-app code that invokes it) sees the new device.
ipcRenderer.on(CHANNELS.HOST_ENV_UPDATE, (_event, snapshot) => {
  if (!snapshot || typeof snapshot !== 'object') return
  const ctx = globalThis.__diminaSpawnContext
  if (!ctx) return
  ctx.hostEnvSnapshot = { ...(ctx.hostEnvSnapshot || {}), ...snapshot }
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

// Block DOM/web globals the service logic must not touch — BUT make the
// definitions `configurable: true`. dimina's service.js (Worker-style runtime
// running here in a window) installs its OWN `globalThis.document` stub during
// boot; a `configurable: false` block makes that redefine throw
// (`Cannot redefine property: document`), aborting service boot so it never
// emits `serviceResourceLoaded` and pages never mount. Keeping these
// configurable lets dimina override them while still surfacing accidental
// access before dimina has set anything up.
const block = (key) => {
  // Don't clobber a global the runtime may already rely on; only guard absent ones.
  if (Object.prototype.hasOwnProperty.call(globalThis, key)) return
  Object.defineProperty(globalThis, key, {
    get() {
      throw new Error(`[service] ${key} not available in service context`)
    },
    configurable: true,
  })
}
;['history', 'sessionStorage'].forEach(block)

// Worker-API shim. dimina's service loader (service/core/loader.js) loads the
// compiled `logic.js` via `globalThis.importScripts(...)` — a Web Worker global
// that doesn't exist in this BrowserWindow service host. The default
// dimina-fe path runs the service in a real Worker; here we run it in a window,
// so without this shim `loadResource` throws and the service never emits
// `serviceResourceLoaded` (the page then never mounts). We fetch each script
// synchronously (mirroring Worker `importScripts`) over the same dev-server
// origin and eval it in the global scope, so its `modDefine(...)` registers
// into the same AMD registry the service loader's `modRequire` reads. Bundles
// are small + same-origin; sync XHR keeps the loader's synchronous contract.
if (typeof globalThis.importScripts !== 'function') {
  globalThis.importScripts = function importScriptsShim(...urls) {
    for (const url of urls) {
      const xhr = new XMLHttpRequest()
      xhr.open('GET', String(url), false)
      xhr.send(null)
      if (xhr.status && (xhr.status < 200 || xhr.status >= 300)) {
        throw new Error(`[service] importScripts failed ${xhr.status} for ${url}`)
      }
      // Indirect eval → runs in global scope (so modDefine/modRequire bind to
      // the service IIFE globals), matching real Worker importScripts semantics.
      ;(0, eval)(`${xhr.responseText}\n//# sourceURL=${url}`)
    }
  }
}

ipcRenderer.on(CHANNELS.TO_SERVICE, (_event, payload) => {
  deliver(payload && payload.msg)
})

// ── Console capture (native-host) ───────────────────────────────────────────
// Placed AFTER the no-bridgeId early-return (pool warming) and AFTER
// DiminaServiceBridge is defined, so it only runs for a real spawn and can use
// the bridge. This preload runs with contextIsolation effectively off, so
// patching `console` here captures the service guest's own console (wx.* +
// logic.js). Each entry is forwarded to main as a `consoleLog` container message
// (source:'service') — bridge-router routes it to ctx.guestConsole → automation
// rebroadcasts it as App.logAdded. Mirrors src/preload/instrumentation/console.ts.

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
    globalThis.DiminaServiceBridge.invoke({
      type: 'consoleLog',
      target: 'container',
      body: {
        source: 'service',
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
