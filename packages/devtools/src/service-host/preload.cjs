const { ipcRenderer } = require('electron')

const CHANNELS = {
  SERVICE_INVOKE: 'dmb:service:invoke',
  SERVICE_PUBLISH: 'dmb:service:publish',
  TO_SERVICE: 'dmb:to-service',
  // main → this window: AppData-panel edit write-back. Mirrors
  // ServiceHostChannel.AppDataSetData in shared/ipc-channels.ts.
  APPDATA_SET_DATA: 'service-host:appdata:set-data',
}

const params = new URLSearchParams(globalThis.location && globalThis.location.search || '')
const bridgeId = params.get('bridgeId')
const { createDeliveryQueue } = require('./service-message-queue.cjs')
const { applyHostEnvUpdate } = require('./host-env-update.cjs')

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

// Custom API namespace globals. service.js installs `globalThis[ns]` proxies for
// `['dd','wx',...apiNamespaces]`, reading the host-configured namespaces from
// `globalThis.__diminaApiNamespaces` first. Set it here (before service.js
// evaluates) from the spawn URL's CSV param so page logic referencing e.g.
// `qd.*` resolves instead of throwing `ReferenceError: qd is not defined`.
// Absent/empty param → `[]`, leaving only the built-in `dd`/`wx`.
const apiNamespacesRaw = params.get('apiNamespaces')
globalThis.__diminaApiNamespaces = apiNamespacesRaw
  ? apiNamespacesRaw.split(',').map((name) => name.trim()).filter(Boolean)
  : []

// Host-registered custom API names (`ElectronRuntime.registerApi('joinIsland', ...)`
// etc.). service.js's `registerEnumerableApiNames()` installs these as real
// own-enumerable forwarding functions on `wx`/`dd` — its Proxy `get` trap
// deliberately returns `undefined` for anything not registered this way, so
// without this the names are silently unusable from mini-program logic.
const registeredApisRaw = params.get('registeredApis')
globalThis.__diminaRegisteredApis = registeredApisRaw
  ? registeredApisRaw.split(',').map((name) => name.trim()).filter(Boolean)
  : []

function reportError(stage, error) {
  const message = error && error.stack ? error.stack : String(error)
  console.error(`[service-host] ${stage}`, error)
  ipcRenderer.send(CHANNELS.SERVICE_INVOKE, {
    msg: {
      type: 'serviceHostError',
      target: 'container',
      // The spawn page goes in the body, where main reads page ids from
      // (`readBridgeId`) — an error raised while it is still up is attributed
      // to it, and one raised after it is gone falls back to the active page.
      body: { stage, message, bridgeId },
    },
  })
}

const queue = createDeliveryQueue({
  // hostEnvUpdate patches the spawn snapshot right before the service reads the same
  // message, so a queued pageResize sees the geometry that was current when it was sent.
  beforeDispatch: (msg) => applyHostEnvUpdate(globalThis.__diminaSpawnContext, msg),
  onError: reportError,
})

Object.defineProperty(globalThis, 'DiminaServiceBridge', {
  value: {
    get onMessage() {
      return queue.getHandler()
    },
    set onMessage(handler) {
      queue.setHandler(handler)
    },
    // Neither send stamps this window's spawn bridgeId: it names the page this
    // service host was STARTED for, which a reLaunch/redirectTo can close while
    // the host keeps serving the session. Main routes by the sending
    // webContents plus the page id the message itself carries.
    invoke(msg) {
      ipcRenderer.send(CHANNELS.SERVICE_INVOKE, { msg })
      return undefined
    },
    publish(targetBridgeId, msg) {
      ipcRenderer.send(CHANNELS.SERVICE_PUBLISH, { targetBridgeId, msg })
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
//
// ── Sourcemap fidelity (console file links) ─────────────────────────────────
// The compiled `logic.js` ships a RELATIVE `//# sourceMappingURL=logic.js.map`
// (see compiler/core/logic-compiler.js). A real Worker `importScripts(url)`
// loads the script with the dev-server URL as its base, so DevTools resolves
// that relative map against `…/{appId}/{root}/logic.js` and fetches the right
// `.map` — console frames + Sources links then point at the developer's
// ORIGINAL files. Under `(0, eval)(...)` the script has NO base URL of its own:
// DevTools resolves a relative `sourceMappingURL` against the service-host
// DOCUMENT (`file://…/service-host/service.html`), fetches a nonexistent
// `file://…/service-host/logic.js.map` (404), and falls back to the compiled
// bundle — so every console file:line points at `logic.js` (compiled), not
// source. Rewrite the relative map URL to an ABSOLUTE one resolved against the
// script's fetch `url`, and put `sourceURL` last, restoring sourcemapped links.
// The pure transform lives in a sibling `.cjs` (unit-tested in
// sourcemap-rewrite.test.ts) — required relative to this preload so it resolves
// from dist/service-host at runtime (build copies both files verbatim).
const { rewriteSourceMappingUrl } = require('./sourcemap-rewrite.cjs')

if (typeof globalThis.importScripts !== 'function') {
  globalThis.importScripts = function importScriptsShim(...urls) {
    for (const url of urls) {
      const xhr = new XMLHttpRequest()
      xhr.open('GET', String(url), false)
      xhr.send(null)
      if (xhr.status && (xhr.status < 200 || xhr.status >= 300)) {
        throw new Error(`[service] importScripts failed ${xhr.status} for ${url}`)
      }
      // Resolve the bundle's relative sourceMappingURL to an absolute dev-server
      // URL (eval'd code has no base URL → relative maps 404 against file://).
      const body = rewriteSourceMappingUrl(xhr.responseText, String(url))
      // Indirect eval → runs in global scope (so modDefine/modRequire bind to
      // the service IIFE globals), matching real Worker importScripts semantics.
      // `sourceURL` goes LAST so the script gets a stable name in the Sources
      // tree while the (now absolute) sourceMappingURL above stays fetchable.
      ;(0, eval)(`${body}\n//# sourceURL=${url}`)
    }
  }
}

// Device changes ride the ordinary service channel as `hostEnvUpdate`; the queue's
// beforeDispatch merges them into `__diminaSpawnContext.hostEnvSnapshot` (the object is
// writable even though the binding is not) in stream order.
ipcRenderer.on(CHANNELS.TO_SERVICE, (_event, payload) => {
  queue.deliver(payload && payload.msg)
})

// AppData-panel edit write-back. The service runtime evaluates in THIS window's
// global context (contextIsolation: false), so `globalThis.getCurrentPages` is
// the runtime's real page stack once boot has installed it. The pure resolver
// lives in a sibling .cjs (unit-tested in appdata-set-data.test.ts), required
// relative to this preload so it resolves from dist/service-host at runtime.
const { applyAppDataSetData } = require('./appdata-set-data.cjs')

ipcRenderer.on(CHANNELS.APPDATA_SET_DATA, (_event, payload) => {
  if (!payload || typeof payload.bridgeId !== 'string' || !payload.data) return
  const applied = applyAppDataSetData(globalThis.getCurrentPages, payload.bridgeId, payload.data)
  // Narrow race: main resolved a live service window but the page unloaded
  // before this handler ran — the write is dropped here. Surface it in the
  // service console (captured via CDP) so the silent no-op is diagnosable.
  if (!applied) {
    console.warn(`[service-host] appdata set-data dropped: no live page for bridge ${payload.bridgeId}`)
  }
})

// ── Uncaught error capture (native-host) ────────────────────────────────────
// Placed AFTER the no-bridgeId early-return (pool warming) and AFTER
// DiminaServiceBridge is defined, so it only runs for a real spawn and can use
// the bridge.
//
// NOTE: `console.*` is deliberately NOT patched here. A wrapper adds a stack
// frame, so the embedded Chrome DevTools (attached natively to this service
// host) would attribute every log to the wrapper line instead of the
// developer's source. Service-layer console output is captured in main via CDP
// `Runtime.consoleAPICalled` (services/service-console) — no extra frame, native
// attribution + sourcemaps preserved. Only WINDOW error / unhandledrejection
// events are posted here: they carry no console call site to preserve and CDP's
// `consoleAPICalled` does not report them. Each is forwarded to main as a
// `consoleLog` container message (source:'service') → bridge-router →
// ctx.guestConsole → automation `App.logAdded`.

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
