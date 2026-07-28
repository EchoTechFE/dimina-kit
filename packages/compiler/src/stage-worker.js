// Resident stage worker — shipped BY this package so downstream doesn't hand-write
// worker glue. One instance runs ONE full compile stage (logic | view | style) in a
// whole realm; the pool (src/pool.js) keeps three of them warm and unions the
// disjoint outputs. This is the dmcc-consistent parallel axis (each stage entirely
// in one realm, so view sees all pages and app-level module dedup still holds).
//
// The wasm toolchain (esbuild-wasm + oxc-parser) can't be inlined here (their Go/WASI
// runtimes break when bundled), and their .wasm assets are host-specific — so the
// host provides ONE `toolchainSetupURL`: an ESM module that, when imported inside
// this worker, installs `globalThis.__esbuildTransform` and `globalThis.__oxcParseSync`
// (see README). That URL is the ONLY wasm-hosting detail the downstream owns; all
// orchestration, fs seeding, reset-reuse and merge live in this package.
//
// Source distribution is deliberately OPFS-free: the pool posts the source map and we
// seed it into our own memfs. A downstream that wants zero-copy OPFS distribution can
// layer it on top (hydrate OPFS -> a files map before calling the pool).
import { Volume, createFsFromVolume } from 'memfs'
import { setupCompile, compileStage, collectOutputs, resetCompilerState } from './compile-core.js'

// The compiler logs diagnostics (missing components, unsupported wx APIs, style
// preprocessor fallbacks, asset-copy failures, …) via console.* inside this worker,
// where a downstream can't see them. Forward them to the pool as { type:'log' } so
// createCompilerPool({ onLog }) can surface them; still log locally for devtools.
for (const level of ['log', 'warn', 'error']) {
  const orig = typeof console[level] === 'function' ? console[level].bind(console) : () => {}
  console[level] = (...args) => {
    try { self.postMessage({ type: 'log', level, message: args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ') }) } catch { /* ignore */ }
    orig(...args)
  }
}

// Load the host's wasm toolchain exactly once. Memoized on the setup URL; a failed
// load clears the cache so a later message can retry instead of replaying the reject.
let toolchainReady = null
let toolchainURL = null
function ensureToolchain(url) {
  if (url) toolchainURL = url
  if (!toolchainReady) {
    if (!toolchainURL) return Promise.reject(new Error('[compiler] stage worker not warmed up: no toolchainSetupURL (call pool.warmup first)'))
    toolchainReady = import(/* @vite-ignore */ toolchainURL)
      .catch((err) => { toolchainReady = null; throw new Error(`[compiler] toolchain setup failed importing ${toolchainURL}: ${(err && err.message) || err}`) })
  }
  return toolchainReady
}

// Stages whose compile path never calls the wasm hooks (__esbuildTransform /
// __oxcParseSync). The CSS pipeline (postcss + cssnano + autoprefixer) is inlined
// in this bundle, so a style-only worker skips importing toolchainSetupURL entirely
// (~13MB esbuild.wasm + oxc WASI it would never call). Unknown/custom stages and
// messages without stage identity conservatively load the toolchain.
const TOOLCHAIN_FREE_STAGES = new Set(['style'])
function needsToolchain(stages) {
  if (!Array.isArray(stages) || stages.length === 0) return true
  return stages.some((s) => !TOOLCHAIN_FREE_STAGES.has(s))
}

function freshFs(files, workPath) {
  return createFsFromVolume(Volume.fromJSON(files, workPath))
}

// Run setupCompile ONCE for a compile: parse config, build the scaffold
// (app-config.json + miniprogram_npm), and collect the { pages, storeInfo } bundle.
// Sharing this one bundle across the per-stage realms lets the heavy setup work (npm
// build, config parse) run once instead of per stage. Scope ids are a deterministic
// hash(path) (dimina utils.js), so the CSS `[data-v-<id>]` selectors and the render
// `Module id` agree across stages no matter who runs setup — the shared bundle is a
// de-dup optimization, not a scope-correctness requirement (see scripts/test-pool-scopehash.js).
async function runSetup(files, workPath, options) {
  const fs = freshFs(files, workPath)
  resetCompilerState()
  const ctx = await setupCompile({ fs, workPath, options })
  const map = collectOutputs({ fs, targetPath: ctx.targetPath })
  const scaffold = {}
  for (const k of Object.keys(map)) if (map[k] != null) scaffold[k] = map[k]
  const bundle = {
    pages: ctx.pages,
    storeInfo: ctx.storeInfo,
    targetPath: ctx.targetPath,
    appId: ctx.appId,
    name: ctx.name,
  }
  return { bundle, scaffold }
}

// Compile only the requested stages against a fresh memfs seeded with the source.
// resetCompilerState() clears the compiler's module-level caches so this warm realm
// stays correct across compiles. Stages write disjoint products; we return this
// worker's subset and the pool unions them.
//
// With a `bundle` (from runSetup), the stage reuses the coordinator's { pages, storeInfo }
// instead of re-running setupCompile — so the npm build / config parse happens once, not
// per stage (mirroring the Node disk pool). Scope ids are a deterministic hash(path), so
// reusing the bundle vs re-deriving would yield the same `data-v-<id>` either way. Stages
// read source from `workPath` and write disjoint products; they never read the setup
// scaffold, so it is not seeded here.
// Without a bundle the worker stays self-contained (single-worker / legacy callers).
// `options` (e.g. { fileTypes }) is only used on the no-bundle fallback path: with a
// bundle, its storeInfo already carries the normalized dialect from the coordinator's
// setupCompile call (see runSetup below / pool.js's runAttempt), restored via
// compileStage -> resetStoreInfo, so re-deriving it here would be redundant.
async function compileSubset(files, workPath, stages, bundle, options) {
  const fs = freshFs(files, workPath)
  resetCompilerState()
  let appId, name, targetPath
  if (bundle) {
    for (const stage of stages) {
      await compileStage({ stage, pages: bundle.pages, storeInfo: bundle.storeInfo, fs })
    }
    ;({ appId, name, targetPath } = bundle)
  } else {
    const ctx = await setupCompile({ fs, workPath, options })
    for (const stage of stages) {
      await compileStage({ stage, pages: ctx.pages, storeInfo: ctx.storeInfo, fs })
    }
    ;({ appId, name, targetPath } = ctx)
  }
  const map = collectOutputs({ fs, targetPath })
  const out = {}
  for (const k of Object.keys(map)) if (map[k] != null) out[k] = map[k]
  return { appId, name, files: out }
}

// Liveness beacon cadence while a request is being processed. The pool's watchdog
// measures inactivity, so these keep a slow-but-alive compile from being judged dead.
// A long synchronous wasm call still blocks the beacon — by design: prolonged total
// silence is exactly the pool's death criterion for a wedged realm.
// Opt-in per message (wantHeartbeat): legacy single-worker consumers of this exported
// worker pair every message as a reply, so unsolicited heartbeats would corrupt them.
const HEARTBEAT_INTERVAL_MS = 2000

self.onmessage = async (e) => {
  const { type } = e.data || {}
  let beacon = null
  if (e.data && e.data.wantHeartbeat) {
    // First beat goes out immediately: the watchdog window starts at postMessage, so a
    // caller-configured timeout shorter than the beacon cadence must still see life
    // before it can fire.
    try { self.postMessage({ type: 'heartbeat' }) } catch { /* ignore */ }
    beacon = setInterval(() => {
      try { self.postMessage({ type: 'heartbeat' }) } catch { /* ignore */ }
    }, HEARTBEAT_INTERVAL_MS)
  }
  try {
    if (type === 'warmup') {
      const t0 = performance.now()
      // Remember the URL even when this worker's stages skip the load, so a later
      // compile-subset that DOES need the toolchain (protocol allows any stages)
      // can still resolve it without re-sending the URL.
      if (e.data.toolchainSetupURL) toolchainURL = e.data.toolchainSetupURL
      if (needsToolchain(e.data.stages)) await ensureToolchain()
      self.postMessage({ type: 'ready', ms: Math.round(performance.now() - t0) })
      return
    }
    if (type === 'setup') {
      // Coordinator phase: one worker parses config, allocates the shared scope-hash
      // ids and builds miniprogram_npm once. setupCompile's npm build can invoke the
      // wasm toolchain, so ensure it's loaded regardless of this worker's own stage.
      const { files, workPath = '/work', options, toolchainSetupURL } = e.data
      if (toolchainSetupURL) toolchainURL = toolchainSetupURL
      await ensureToolchain()
      const t = performance.now()
      const { bundle, scaffold } = await runSetup(files, workPath, options)
      self.postMessage({ type: 'setup-done', bundle, scaffold, ms: Math.round(performance.now() - t) })
      return
    }
    if (type === 'compile-subset') {
      const { files, workPath = '/work', stages = ['logic', 'view', 'style'], bundle, options, toolchainSetupURL } = e.data
      if (toolchainSetupURL) toolchainURL = toolchainSetupURL
      if (needsToolchain(stages)) await ensureToolchain()
      const warm = !!toolchainReady
      const t = performance.now()
      const result = await compileSubset(files, workPath, stages, bundle, options)
      self.postMessage({ type: 'done', result, ms: Math.round(performance.now() - t), warm })
      return
    }
  } catch (err) {
    self.postMessage({ type: 'error', error: String((err && err.stack) || err) })
  } finally {
    if (beacon) clearInterval(beacon)
  }
}
