// Resident Node worker_threads stage worker for the disk pool.
//
// One of these runs per stage (logic | view | style). It stays warm across builds
// (the pool never terminates it between compiles) and writes its stage's product
// files DIRECTLY to the shared real-disk staging dir (getTargetPath(), carried in
// the storeInfo the main thread ships). Stages write disjoint file names, so the
// three workers can write the same staging dir concurrently — exactly like dmcc's
// own index.js does.
//
// fs is NATIVE here (this bundle is built without the fs alias — see build-compiler.js),
// so dmcc's `import fs from 'node:fs'` hits real disk. worker_threads is SHIMMED for
// dmcc (isMainThread=true) so its own parentPort bootstrap stays off; we grab the REAL
// parentPort via createRequire to talk to the pool.
import { createRequire } from 'node:module'
import { runStage, resetCompilerState, preloadStage, STAGE_NAMES } from './compile-core.js'
import { resetStoreInfo, getAppId, getAppName } from '../../../dimina/fe/packages/compiler/src/env.js'

const require = createRequire(import.meta.url)
const { parentPort, workerData } = require('node:worker_threads')

if (!parentPort) {
  throw new Error('[compiler] stage-worker-node.js must run inside a worker_threads Worker')
}

// The pool declares this worker's stage identity at spawn (workerData.stage), so the
// worker warms its OWN stage's toolchain immediately — the resident pool is compile-ready
// from creation without any realm ever loading another stage's heavy deps. Fire-and-forget:
// a preload failure resurfaces on the first build's own lazy load, with a real reply path.
const declaredStage = workerData && workerData.stage
if (declaredStage && STAGE_NAMES.includes(declaredStage)) {
  preloadStage(declaredStage).catch(() => {})
}

// Heavy toolchain packages a realm may load; introspect reports which of them are present
// in THIS worker's CJS require cache. oxc-parser's own entry is pure ESM (it never lands
// in require.cache) — its natively-required binding under the @oxc-parser scope is the
// cache-visible evidence, so that scope counts as oxc-parser. Purely-ESM packages with no
// CJS footprint at all (cheerio) are invisible to this probe by nature.
const HEAVY_PACKAGES = [
  'sass', 'cssnano', 'less', 'autoprefixer', 'cheerio', '@vue/compiler-sfc',
  'oxc-parser', 'oxc-walker', 'esbuild', 'htmlparser2', 'postcss',
]
const HEAVY_ALIASES = { 'oxc-parser': ['oxc-parser', '@oxc-parser'] }

function loadedHeavyPackages() {
  const keys = Object.keys(require.cache || {})
  return HEAVY_PACKAGES.filter((name) =>
    (HEAVY_ALIASES[name] || [name]).some((n) => keys.some((k) => k.includes(`node_modules/${n}/`))))
}

// Liveness beacon cadence while a build is being processed — the pool's watchdog
// measures inactivity, so a long-but-alive disk build is never judged dead while a
// truly wedged worker (blocked event loop) goes silent and is caught in one window.
const HEARTBEAT_INTERVAL_MS = 2000

parentPort.on('message', async (msg) => {
  // Diagnostic probe: report which heavy toolchain packages this realm has loaded.
  // Answered inline (never enters the compile path), FIFO-paired like any reply.
  if (msg && msg.type === 'introspect') {
    parentPort.postMessage({ type: 'introspect', stage: declaredStage || null, loaded: loadedHeavyPackages() })
    return
  }
  const { stage, pages, storeInfo, sourcemap } = msg || {}
  // Opt-in per message (wantHeartbeat), mirroring stage-worker.js: only a supervising
  // pool that treats heartbeats as out-of-band liveness asks for them. First beat goes
  // out immediately so even a timeout shorter than the cadence sees life first.
  let beacon = null
  if (msg && msg.wantHeartbeat) {
    try { parentPort.postMessage({ type: 'heartbeat' }) } catch { /* ignore */ }
    beacon = setInterval(() => {
      try { parentPort.postMessage({ type: 'heartbeat' }) } catch { /* ignore */ }
    }, HEARTBEAT_INTERVAL_MS)
  }
  try {
    // Warm-realm hygiene: clear this worker's module-level caches so a reused worker
    // does not leak state from the previous build (same contract as the browser pool).
    resetCompilerState()
    // Restore the env singletons (paths/config/targetPath) from the main thread's setup.
    resetStoreInfo(storeInfo)
    await runStage(stage, pages, { sourcemap })
    parentPort.postMessage({ type: 'done', stage, appId: getAppId(), name: getAppName() })
  } catch (error) {
    parentPort.postMessage({
      type: 'error',
      stage,
      error: { message: error && error.message, stack: error && error.stack, name: error && error.name },
    })
  } finally {
    if (beacon) clearInterval(beacon)
  }
})
