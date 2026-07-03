// Resident Node worker_threads disk pool — the Node counterpart of pool.js (browser).
//
// It reproduces dmcc's own `build()` behavior (3 stage workers writing a shared real-disk
// staging dir, then publishToDist copies to outputDir/{appId}), including sourcemap, but
// keeps the workers WARM across builds instead of spawning+terminating them each time.
// That resident realm reuse is the point: watch/rebuild in an IDE amortizes worker spawn +
// module init instead of re-paying it on every save.
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
import { createDist, publishToDist } from '../../../dimina/fe/packages/compiler/src/common/publish.js'
import { getAppConfigInfo, getAppId, getAppName } from '../../../dimina/fe/packages/compiler/src/env.js'

const { Worker } = createRequire(import.meta.url)('node:worker_threads')

/**
 * Create a resident Node stage-worker pool.
 * @param {{ stages?: string[] }} [opts]
 * @returns {{ build: (outputDir:string, workPath:string, useAppIdDir?:boolean, options?:object)=>Promise<{appId:string,name:string,path:string}>, dispose: ()=>Promise<void>, stages: string[] }}
 */
// ALL Node disk-pool builds serialize through this single module-level chain, not a
// per-instance one: setupCompile/publishToDist go through dmcc's process-global env
// singletons (storeInfo / getTargetPath / getAppId), so builds from two DIFFERENT
// pool instances would corrupt each other just as surely as two builds in one pool
// (one pool publishing the other's staging dir under the other's appId).
let chain = Promise.resolve()

export function createNodeCompilerPool({ stages = STAGE_NAMES } = {}) {
  const workerURL = new URL('./stage-worker.node.js', import.meta.url)
  let disposed = false

  const workers = stages.map((stage) => {
    // Slot with lazy respawn: a crashed/exited worker fails the builds queued on it,
    // vacates the slot, and the NEXT send() forks a fresh worker — a dead stage must
    // not wedge every later rebuild (postMessage to an exited worker neither throws
    // nor ever answers).
    const slot = { stage, w: null, q: [] }
    const spawn = () => {
      const w = new Worker(workerURL)
      const settle = (v) => { const r = slot.q.shift(); if (r) r(v) }
      w.on('message', settle)
      w.on('error', (e) => settle({ type: 'error', stage, error: { message: e && e.message, stack: e && e.stack } }))
      w.on('exit', (code) => {
        if (slot.w === w) slot.w = null
        while (slot.q.length) settle({ type: 'error', stage, error: { message: `stage worker "${stage}" exited (code ${code})` } })
      })
      return w
    }
    // Spawn eagerly so the pool is warm from creation (the resident-realm point);
    // only replacements after a death are lazy.
    slot.w = spawn()
    slot.send = (m) => new Promise((res) => {
      if (!slot.w) slot.w = spawn()
      slot.q.push(res)
      slot.w.postMessage(m)
    })
    return slot
  })

  async function runBuild(outputDir, workPath, useAppIdDir, options) {
    const { sourcemap = false, fileTypes } = options || {}

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
    const results = await Promise.all(
      workers.map((x) => x.send({ stage: x.stage, pages, storeInfo, sourcemap })),
    )
    for (const r of results) {
      if (!r || r.type === 'error') {
        const info = r && r.error
        const err = new Error(`[compiler] stage "${r && r.stage}" failed: ${(info && info.message) || 'unknown error'}`)
        if (info && info.stack) err.stack = info.stack
        err.stage = r && r.stage
        throw err
      }
    }

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
    if (disposed) return Promise.reject(new Error('[compiler] pool has been disposed'))
    const result = chain.then(() => runBuild(outputDir, workPath, useAppIdDir, options))
    chain = result.then(() => {}, () => {})
    return result
  }

  async function dispose() {
    disposed = true
    await Promise.all(workers.map((x) => (x.w ? x.w.terminate() : null)))
  }

  // _slots is a test hook (crash-recovery tests terminate a live worker through
  // it); not part of the supported API surface.
  return { build, dispose, stages, _slots: workers }
}

// dmcc listr2 stage titles — reproduced so the drop-in build() surfaces the same
// user-facing compile-log lines a host (e.g. devkit/devtools' log panel) already scrapes.
const STAGE_TITLES = { logic: '编译页面逻辑', view: '编译页面文件', style: '编译样式文件' }

// Lazy singleton pool — a DROP-IN replacement for dmcc's `build(targetPath, workPath,
// useAppIdDir, options)`, matching its behavior on BOTH the happy and error paths so a
// host that consumed dmcc keeps working unchanged:
//   • the first call spins up the resident workers; every later call (a watch rebuild)
//     reuses them warm;
//   • on success it emits `✔ 输出编译产物` on stdout (dmcc's listr2 completion line — the
//     pool has no listr2, so the equivalent user-facing line is surfaced here);
//   • on failure it reports the failing stage + summary on stderr and RESOLVES undefined
//     (never rethrows), exactly like dmcc's build() catch (index.js) — the host normalizes
//     undefined to a null appInfo and the error detail (incl. dmcc's own
//     `[logic] esbuild 转换失败 …`) still reaches the log channel.
// Callers that want structured throwing errors + explicit teardown should use
// createNodeCompilerPool() directly instead.
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
    return undefined
  }
}

/** Terminate the lazy singleton pool's workers (no-op if never used). */
export async function disposeDefaultPool() {
  if (singleton) {
    await singleton.dispose()
    singleton = null
  }
}
