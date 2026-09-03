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
import { setupCompile, compileStage, collectOutputs, resetCompilerState } from './compile-core.js'
import { COMPILER_ERROR_CODES } from './error-codes.js'
import { seedMemfs } from './seed-memfs.js'

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

// Load the host's wasm toolchain exactly once.
//
// A worker is BOUND to the first setup URL it is given, and a message carrying a
// different one is rejected. The hooks are installed as an import side effect, and ESM
// caches a module by URL: re-importing one that already ran does not run it again. So a
// worker cannot honestly switch toolchains — going A -> B -> A would leave B's hooks
// installed while the worker reports A as ready, and two overlapping imports would leave
// whichever finished last installed regardless of which was asked for. A caller that
// needs a different toolchain needs a different worker.
//
// A failed load clears the memo so a later message can retry the same URL instead of
// replaying the reject.
//
// Every stage loads it. The style stage used to skip it — its CSS pipeline (postcss +
// cssnano + autoprefixer) is inlined in this bundle — but the upstream compiler now
// minifies non-sourcemap builds through esbuild's `transform` (cssnano only on the
// sourcemap path), so style compiles call __esbuildTransform too, and a warmup can't
// know which path a later compile-subset will take.
let toolchainReady = null
let toolchainURL = null
function ensureToolchain(url) {
  if (url && !toolchainURL) toolchainURL = url
  if (!toolchainURL) return Promise.reject(new Error('[compiler] stage worker not warmed up: no toolchainSetupURL (call pool.warmup first)'))
  if (url && url !== toolchainURL) {
    return Promise.reject(new Error(`[compiler] stage worker is already bound to toolchainSetupURL ${toolchainURL}; a different toolchain needs a new worker (got ${url})`))
  }
  if (!toolchainReady) {
    const pending = toolchainURL
    toolchainReady = import(/* @vite-ignore */ pending)
      .catch((err) => {
        toolchainReady = null
        // Coded, because only this worker can tell "the host's wasm assets didn't load"
        // apart from "the project doesn't compile". The pool forwards the code, and the
        // host uses it to retry or fall back instead of matching the message text.
        throw Object.assign(
          new Error(`[compiler] toolchain setup failed importing ${pending}: ${(err && err.message) || err}`),
          { code: COMPILER_ERROR_CODES.toolchainSetupFailed },
        )
      })
  }
  return toolchainReady
}

function freshFs(files, workPath) {
  return seedMemfs(files, workPath)
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
      // The URL is remembered here so a later compile-subset can resolve it without
      // re-sending it.
      await ensureToolchain(e.data.toolchainSetupURL)
      self.postMessage({ type: 'ready', ms: Math.round(performance.now() - t0) })
      return
    }
    if (type === 'setup') {
      // Coordinator phase: one worker parses config, allocates the shared scope-hash
      // ids and builds miniprogram_npm once. setupCompile's npm build can invoke the
      // wasm toolchain, so ensure it's loaded regardless of this worker's own stage.
      const { files, workPath = '/work', options, toolchainSetupURL } = e.data
      await ensureToolchain(toolchainSetupURL)
      const t = performance.now()
      const { bundle, scaffold } = await runSetup(files, workPath, options)
      self.postMessage({ type: 'setup-done', bundle, scaffold, ms: Math.round(performance.now() - t) })
      return
    }
    if (type === 'compile-subset') {
      const { files, workPath = '/work', stages = ['logic', 'view', 'style'], bundle, options, toolchainSetupURL } = e.data
      await ensureToolchain(toolchainSetupURL)
      const warm = !!toolchainReady
      const t = performance.now()
      const result = await compileSubset(files, workPath, stages, bundle, options)
      self.postMessage({ type: 'done', result, ms: Math.round(performance.now() - t), warm })
      return
    }
  } catch (err) {
    // `code` only when this worker classified the failure itself; the pool defaults the
    // rest to compiler-stage-error.
    self.postMessage({ type: 'error', error: String((err && err.stack) || err), code: (err && err.code) || undefined })
  } finally {
    if (beacon) clearInterval(beacon)
  }
}
