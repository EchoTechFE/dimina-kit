// Resident Node worker_threads disk pool — the Node counterpart of pool.js (browser).
//
// It reproduces dmcc's own `build()` behavior (3 stage workers writing a shared real-disk
// staging dir, then publishToDist copies to outputDir/{appId}), including sourcemap, but
// keeps the workers WARM across builds instead of spawning+terminating them each time.
// That resident realm reuse is the point: watch/rebuild in an IDE amortizes worker spawn +
// module init instead of re-paying it on every save.
//
// Worker supervision (inactivity watchdog, immediate terminate on death, generation guard
// against stale replies, terminate-ack-gated respawn) is the SAME src/worker-slot.js
// state machine the browser pool uses — a wedged-but-alive worker times out and the build
// rejects instead of pending forever (and queueing every later build behind it). The
// terminate-ack gate matters more here than in the browser: stage workers write a SHARED
// real-disk staging dir, so a retry must never start while the previous attempt's worker
// could still be writing.
//
// Flow per build():
//   main   : setupCompile → prep on real disk (storeInfo/createDist/compileConfig/npm)
//   workers: resetCompilerState + resetStoreInfo + runStage(stage) → write staging disk
//   main   : publishToDist(outputDir) → copy staging → outputDir/{appId}
//
// fs is NATIVE (bundled without the fs alias); worker_threads is shimmed for dmcc but the
// REAL Worker/parentPort are reached via createRequire (see stage-worker-node.js).
import { createRequire } from 'node:module'
import nodeFs from 'node:fs'
import nodePath from 'node:path'
import process from 'node:process'
import { setupCompile, resetCompilerState, STAGE_NAMES } from './compile-core.js'
import { createWorkerSlot, settleAll } from './worker-slot.js'
import { publishToDist } from '../../../dimina/fe/packages/compiler/src/common/publish.js'
import { getAppConfigInfo, getAppId, getAppName } from '../../../dimina/fe/packages/compiler/src/env.js'

const { Worker } = createRequire(import.meta.url)('node:worker_threads')

// Default INACTIVITY ceiling per stage build. The stage worker heartbeats every 2s while
// it works, so this only expires after that much total silence — which for a live worker
// means a truly wedged realm, not a big-but-progressing project. Deliberately more
// generous than the browser default: disk builds run whole real projects.
const DEFAULT_SEND_TIMEOUT_MS = 120000

// 'compiler-toolchain-dead' belongs here even though the worker THREAD is alive: the
// realm's esbuild service child process is gone, so the realm is just as unusable as a
// crashed worker — the same one-retry-on-fresh-workers policy applies.
const WORKER_DEATH_CODES = new Set(['compiler-worker-timeout', 'compiler-worker-crashed', 'compiler-worker-dead', 'compiler-toolchain-dead'])

// esbuild's node lib drives a spawned long-lived binary child (its "service"). When that
// child dies (spawn ENOENT in a packaged app, OOM kill, AV kill), esbuild reports every
// call with one of these two phrases — and the service NEVER restarts inside that realm,
// so the warm worker is permanently broken and must be recycled, not kept.
function isDeadToolchainServiceError(message) {
  return /The service (was stopped|is no longer running)/.test(String(message))
}

// Default idle window before the pool shrinks (terminates its resident stage workers to
// release their memory — a warm worker set holds hundreds of MB of toolchain + compile
// allocations). Shrinking is transparent: the next build's ensureAlive respawns fresh
// workers, paying only their spawn + own-stage toolchain load again. Five minutes keeps
// rapid edit-compile loops warm while an IDE left idle overnight stops holding the memory.
const DEFAULT_IDLE_SHRINK_MS = 300000

/**
 * Create a resident Node stage-worker pool.
 * @param {{
 *   stages?: string[],
 *   sendTimeoutMs?: number,        // default 120000 — inactivity window per stage build
 *   retryOnWorkerDeath?: boolean,  // default true — one transparent whole-build retry after a worker death
 *   idleShrinkMs?: number|false,   // default 300000 — idle ms before workers are shrunk; 0/false/Infinity disables
 * }} [opts]
 * @returns {{ build: (outputDir:string, workPath:string, useAppIdDir?:boolean, options?:object)=>Promise<{appId:string,name:string,path:string}>, dispose: ()=>Promise<void>, stages: string[] }}
 */
// ALL Node disk-pool builds serialize through this single module-level chain, not a
// per-instance one: setupCompile/publishToDist go through dmcc's process-global env
// singletons (storeInfo / getTargetPath / getAppId), so builds from two DIFFERENT
// pool instances would corrupt each other just as surely as two builds in one pool
// (one pool publishing the other's staging dir under the other's appId).
let chain = Promise.resolve()

export function createNodeCompilerPool({
  stages = STAGE_NAMES,
  sendTimeoutMs = DEFAULT_SEND_TIMEOUT_MS,
  retryOnWorkerDeath = true,
  idleShrinkMs = DEFAULT_IDLE_SHRINK_MS,
} = {}) {
  const workerURL = new URL('./stage-worker.node.js', import.meta.url)
  let disposed = false

  const workers = stages.map((stage) => {
    // `w` mirrors the current live Worker for the `_slots` test hook (crash-recovery
    // tests terminate a live worker through it); everything else goes through the slot.
    const entry = { stage, w: null }
    entry.slot = createWorkerSlot({
      name: `[compiler] stage '${stage}' worker`,
      spawnTransport: ({ onMessage, onCrash }) => {
        // workerData carries the worker's stage identity so it can preload its OWN
        // stage's toolchain at spawn (and only that one) — see stage-worker-node.js.
        const w = new Worker(workerURL, { workerData: { stage } })
        entry.w = w
        w.on('message', onMessage)
        w.on('error', (e) => onCrash(`stage worker "${stage}" error: ${(e && e.message) || e}`))
        w.on('exit', (code) => onCrash(`stage worker "${stage}" exited (code ${code})`))
        return { postMessage: (m) => w.postMessage(m), terminate: () => w.terminate() }
      },
      // Heartbeats are pure liveness for the inactivity watchdog, never a reply.
      onEvent: (d) => !!(d && d.type === 'heartbeat'),
    })
    // Spawn eagerly so the pool is warm from creation (the resident-realm point); a
    // spawn failure surfaces on the first build's own ensureAlive.
    entry.slot.ensureAlive().catch(() => {})
    return entry
  })

  // --- idle shrink ----------------------------------------------------------
  // Armed whenever THIS pool has no build queued or running (including right after
  // creation — a pool that is spawned but never builds must not hold its workers
  // forever); cancelled the moment a new build arrives. When it fires, every slot's
  // transport is terminated (slot.shrink() — a no-op under in-flight traffic by
  // design) and the next build's ensureAlive respawns transparently. unref()'d so
  // the pending timer itself never pins an otherwise-done process; while workers
  // are alive THEY hold the event loop, which is exactly what lets the timer fire.
  const shrinkEnabled = idleShrinkMs > 0 && idleShrinkMs < Infinity
  let idleTimer = null
  let activeBuilds = 0

  function cancelIdleShrink() {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
  }

  function armIdleShrink() {
    if (!shrinkEnabled || disposed) return
    cancelIdleShrink()
    idleTimer = setTimeout(() => {
      idleTimer = null
      if (disposed || activeBuilds > 0) return
      for (const x of workers) x.slot.shrink()
    }, idleShrinkMs)
    if (typeof idleTimer.unref === 'function') idleTimer.unref()
  }

  armIdleShrink()

  // One full build attempt. Ends quiescent: settleAll guarantees no stage request is
  // still in flight when it returns/throws, so a retry can't cross-pair replies.
  async function runAttempt(outputDir, workPath, useAppIdDir, options) {
    const { sourcemap = false, fileTypes } = options || {}

    // 0) Respawn anything that died (ensureAlive awaits the dead worker's terminate()
    //    settlement first — it must be fully stopped before a new attempt touches the
    //    shared staging dir).
    await settleAll(workers.map((x) => x.slot.ensureAlive()))

    // 1) Prep once on real disk. resetCompilerState first so a warm main realm does not
    //    carry caches (assets/config) from the previous build. setupCompile computes a
    //    fresh staging dir (getTargetPath) and scaffolds it via createDist.
    resetCompilerState()
    // outputDir resolved exactly like publishToDist resolves it (against cwd), so
    // when it sits inside the project the npm scan skips the published output —
    // a previous build's copies must never become the next build's input.
    const ctx = await setupCompile({
      fs: nodeFs,
      workPath,
      options: { fileTypes },
      npmScanExclude: [nodePath.resolve(process.cwd(), outputDir)],
    })
    const { storeInfo, pages } = ctx

    // 2) Fan out to the resident stage workers. They restore the same storeInfo (so their
    //    getTargetPath() is the same staging dir) and write disjoint files concurrently.
    //    Worker DEATH (timeout/crash/exit) arrives as a coded rejection; the worker's own
    //    { type:'error' } replies (real compile errors) are normalized below.
    const results = await settleAll(workers.map((x) =>
      x.slot.request(
        { stage: x.stage, pages, storeInfo, sourcemap, wantHeartbeat: true },
        { timeoutMs: sendTimeoutMs, description: `stage '${x.stage}' build` },
      ).catch((err) => {
        if (err && err.code && !err.stage) err.stage = x.stage
        throw err
      })))
    // Walk EVERY result before throwing: when more than one stage hit a dead toolchain
    // service (logic and view both drive esbuild), each broken realm must be recycled
    // now — throwing on the first would leave the sibling's dead service warm, and the
    // next build would fail on it all over again.
    let firstErr = null
    for (let i = 0; i < results.length; i++) {
      const r = results[i]
      if (r && r.type !== 'error') continue
      const info = r && r.error
      const cause = (info && info.message) || 'unknown error'
      const hint = oxcNativeBindingHint(cause) || esbuildAsarSpawnHint(cause)
      const err = new Error(`[compiler] stage "${r && r.stage}" failed: ${cause}${hint ? ` — ${hint}` : ''}`)
      if (info && info.stack) err.stack = info.stack
      err.stage = r && r.stage
      if (isDeadToolchainServiceError(cause)) {
        // The realm's toolchain service child is dead and never comes back — terminate
        // the worker so the next attempt (the transparent retry, or the next build once
        // the environment is healed) respawns a fresh realm with a fresh service.
        // shrink() is safe here: settleAll above guarantees no request is in flight.
        err.code = 'compiler-toolchain-dead'
        workers[i].slot.shrink()
      } else {
        err.code = 'compiler-stage-error' // worker-reported compile error — never retried
      }
      if (!firstErr) firstErr = err
    }
    if (firstErr) throw firstErr

    // 3) Publish the staging dir to the caller's outputDir (dmcc-identical layout).
    publishToDist(outputDir, useAppIdDir)

    return {
      appId: getAppId(),
      name: getAppName(),
      // dmcc reads mainPages[1] only because its style task unshifts `app` into the
      // SHARED array first, making [1] the original FIRST page. Our style stage builds
      // a fresh array instead of mutating, so the equivalent here is mainPages[0].
      path: getAppConfigInfo().entryPagePath || pages.mainPages[0]?.path || '',
    }
  }

  function build(outputDir, workPath, useAppIdDir = true, options = {}) {
    if (disposed) {
      return Promise.reject(Object.assign(new Error('[compiler] pool has been disposed'), { code: 'compiler-pool-disposed' }))
    }
    // New activity: a pending shrink is off the table until this pool drains again.
    cancelIdleShrink()
    activeBuilds += 1
    const result = chain.then(async () => {
      try {
        return await runAttempt(outputDir, workPath, useAppIdDir, options)
      } catch (err) {
        // A worker death is often transient (OOM-killed thread, machine pressure) —
        // retry the WHOLE build once on fresh workers. The retry's ensureAlive gates on
        // the dead worker's terminate() ack, and setupCompile recreates the staging dir
        // from scratch (createDist), so the failed attempt cannot contaminate it. Real
        // compile errors are deterministic and are never retried.
        if (!retryOnWorkerDeath || !err || !WORKER_DEATH_CODES.has(err.code)) throw err
        return await runAttempt(outputDir, workPath, useAppIdDir, options)
      }
    })
    chain = result.then(() => {}, () => {})
    const settled = () => {
      activeBuilds -= 1
      if (activeBuilds === 0) armIdleShrink()
    }
    result.then(settled, settled)
    return result
  }

  async function dispose() {
    disposed = true
    cancelIdleShrink()
    await Promise.all(workers.map((x) => x.slot.dispose()))
  }

  // _slots is a test hook (crash-recovery tests terminate a live worker through
  // it); not part of the supported API surface.
  return { build, dispose, stages, _slots: workers }
}

// dmcc listr2 stage titles — reproduced so the drop-in build() surfaces the same
// user-facing compile-log lines a host (e.g. devkit/devtools' log panel) already scrapes.
const STAGE_TITLES = { logic: '编译页面逻辑', view: '编译页面文件', style: '编译样式文件' }

/**
 * Map a failure message to an actionable packaging hint when it is esbuild failing to
 * spawn its native binary from inside an Electron app.asar archive. Electron patches
 * child_process.execFile for asar paths but NOT child_process.spawn (which esbuild
 * uses), so an in-archive binary path always ENOENTs at spawn even though fs sees the
 * file — the raw message points at a path that plainly exists, which is why it needs
 * a hint. Returns null for every other message.
 * @param {string} message
 * @returns {string | null}
 */
export function esbuildAsarSpawnHint(message) {
  const msg = String(message)
  if (!/app\.asar/.test(msg) || !/esbuild/i.test(msg) || !/ENOENT/.test(msg)) return null
  return 'esbuild 的原生二进制无法从 app.asar 内 spawn（Electron 只为 execFile 打 asar 补丁）：'
    + "打包配置需 asarUnpack '**/node_modules/esbuild/**' 与 '**/node_modules/@esbuild/**'，"
    + '并确保 ESBUILD_BINARY_PATH 指向 app.asar.unpacked 下的真实二进制（@dimina-kit/devkit 在 asar 内运行时会自动设置）'
}

/**
 * Map a failure message to an actionable packaging hint when it is oxc-parser's
 * "missing runtime binding" error (thrown when NEITHER the platform-native
 * `@oxc-parser/binding-<platform>` package NOR the `@oxc-parser/binding-wasm32-wasi`
 * fallback resolves at runtime). Neither package is a direct dependency of a
 * typical host, so app bundlers (e.g. electron-builder's dependency collection)
 * silently drop them — and the raw oxc message says nothing about packaging.
 * Returns null for every other message.
 * @param {string} message
 * @returns {string | null}
 */
export function oxcNativeBindingHint(message) {
  if (!/Cannot find native binding/i.test(String(message))) return null
  return 'oxc-parser 的运行时绑定没有被打进宿主应用：@dimina-kit/compiler 的 Node 编译路径需要 '
    + `@oxc-parser/binding-${process.platform}-${process.arch}（平台原生绑定）或 `
    + '@oxc-parser/binding-wasm32-wasi（wasm 兜底）二者之一实际存在于包内。'
    + '打包分发（如 electron-builder）时请把其中一个显式声明为宿主依赖，避免依赖收集时被丢弃'
}

// Lazy singleton pool — a DROP-IN replacement for dmcc's `build(targetPath, workPath,
// useAppIdDir, options)` with ONE deliberate divergence on the error path:
//   • the first call spins up the resident workers; every later call (a watch rebuild)
//     reuses them warm;
//   • on success it emits `✔ 输出编译产物` on stdout (dmcc's listr2 completion line — the
//     pool has no listr2, so the equivalent user-facing line is surfaced here);
//   • on failure it reports the failing stage + summary on stderr (same lines a dmcc
//     host already scrapes: `✖ <stage>` + `<workPath> 编译出错: …`) and then REJECTS
//     with the error. dmcc's own build() swallows the error and resolves undefined,
//     which makes a failed compile indistinguishable from benign "no app info" — a
//     host would start a session that can only 404. Rejecting keeps the log surface
//     identical while giving callers a real failure signal; a resolved null/undefined
//     no longer means "compile failed", only "no app info to report".
// Callers that want structured errors (`.stage`/`.code`) + explicit teardown should
// use createNodeCompilerPool() directly instead.
let singleton = null
export default async function build(outputDir, workPath, useAppIdDir = true, options = {}) {
  if (!singleton) singleton = createNodeCompilerPool()
  try {
    const info = await singleton.build(outputDir, workPath, useAppIdDir, options)
    console.log('✔ 输出编译产物')
    return info
  } catch (e) {
    if (e && e.stage) console.error(`✖ ${STAGE_TITLES[e.stage] || e.stage}`)
    console.error(`${workPath} 编译出错: ${e && e.message}`)
    throw e
  }
}

/**
 * Create the lazy singleton pool (if absent) and wait for its stage workers to be
 * up — WITHOUT building anything and without any stdout. A host that knows a build
 * is coming (e.g. a warm-standby compile worker forked while no project is open)
 * calls this so the first real `build()` starts on already-spawned, toolchain-warm
 * workers. Spawn failures are swallowed here and resurface on the first build's
 * own ensureAlive — warming is best-effort acceleration, never a failure source.
 */
export async function warmDefaultPool() {
  if (!singleton) singleton = createNodeCompilerPool()
  await Promise.all(singleton._slots.map((x) => x.slot.ensureAlive().catch(() => {})))
}

/** Terminate the lazy singleton pool's workers (no-op if never used). */
export async function disposeDefaultPool() {
  if (singleton) {
    await singleton.dispose()
    singleton = null
  }
}
