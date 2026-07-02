// dmcc adapter: drives @dimina/compiler's compile functions inline (no
// worker_threads) against a caller-injected fs. web-compiler owns NO fs
// implementation — the host passes a node:fs replacement (e.g. memfs) already
// seeded with the project source under workPath.
import { setFs, resetFs } from './shims/fs.js'

// The compiler source lives in dimina-kit's `dimina` submodule. This package
// sits inside the same dimina-kit checkout, so the path stays relative to the
// submodule — no machine-specific absolute prefix. esbuild resolves these at
// bundle time (see scripts/build-compiler.js).
import {
  storeInfo, resetStoreInfo, getPages, getAppId, getAppName, getWorkPath, getTargetPath,
} from '../../../dimina/fe/packages/compiler/src/env.js'
import { createDist } from '../../../dimina/fe/packages/compiler/src/common/publish.js'
import { compileConfig } from '../../../dimina/fe/packages/compiler/src/core/index.js'
import { NpmBuilder } from '../../../dimina/fe/packages/compiler/src/common/npm-builder.js'
// compileJS exported by source; writeCompileRes + __resetLogicState + __setEnableSourcemap
// appended at bundle time (see scripts/build-compiler.js). __setEnableSourcemap flips the
// logic compiler's module-level `enableSourcemap` — the ONLY sourcemap entry point, since
// this package short-circuits dmcc's `parentPort` worker bootstrap (isMainThread=true shim).
import { compileJS, writeCompileRes, __resetLogicState, __setEnableSourcemap } from '../../../dimina/fe/packages/compiler/src/core/logic-compiler.js'
// compileML + __resetViewState (appended at bundle time)
import { compileML, __resetViewState } from '../../../dimina/fe/packages/compiler/src/core/view-compiler.js'
import { compileSS, __resetStyleState } from '../../../dimina/fe/packages/compiler/src/core/style-compiler.js'
// __resetAssets appended at bundle time (clears the never-cleared assetsMap cache)
import { __resetAssets } from '../../../dimina/fe/packages/compiler/src/common/utils.js'

function makeProgress() {
  let c = 0
  return {
    get completedTasks() { return c },
    set completedTasks(v) { c = v },
  }
}

// The compiler reads the app id from project.config.json's `appid` and bakes it
// into output resource paths (`/{appId}/main/static/…`) and the container's
// `?appId=` query. An embedder that feeds a minimal project may omit
// project.config.json, which would leave the id `undefined` — corrupting those
// paths and the container load with no error surfaced. When no appid is present
// we inject this fixed local-preview id. A constant (not a content hash) keeps
// the id stable across content edits so a live-edit/HMR host preserves page state.
const SYNTHETIC_APPID = 'dmlocalpreview'

// Ensure the injected fs has a project.config.json carrying a usable `appid`.
// Honors a caller-provided one; synthesizes a stable fallback when absent.
// NOTE: when appid is missing this WRITES project.config.json into the caller's
// fs. It refuses to clobber a file that isn't valid JSON, and rejects a
// malformed appid — better a clear error than silent data loss / corrupt paths.
function ensureAppIdFs(fs, configPath) {
  let config = {}
  if (fs.existsSync(configPath)) {
    const raw = fs.readFileSync(configPath, 'utf8')
    try {
      config = JSON.parse(raw)
    } catch {
      throw new Error(`[compiler] ${configPath} is not valid JSON; refusing to overwrite it`)
    }
    if (config === null || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error(`[compiler] ${configPath} must be a JSON object`)
    }
  }
  const { appid } = config
  if (appid !== undefined && appid !== '' && typeof appid !== 'string') {
    throw new Error(`[compiler] ${configPath} "appid" must be a non-empty string`)
  }
  if (!appid) {
    config.appid = SYNTHETIC_APPID
    const slash = configPath.lastIndexOf('/')
    if (slash > 0) fs.mkdirSync(configPath.slice(0, slash), { recursive: true })
    fs.writeFileSync(configPath, JSON.stringify(config))
  }
}

// Walk the injected fs under targetPath and collect { relPath: content }. Uses
// only readdirSync({withFileTypes}) + readFileSync — inside the fs contract.
// Fail-fast: a missing target dir, an unreadable product, or a fs that ignores
// { withFileTypes: true } throws (with the path) rather than silently dropping
// products or crashing obscurely later.
function readOutputs(fs, target) {
  const prefix = target.endsWith('/') ? target : `${target}/`
  const out = {}
  const seen = new Set()
  const walk = (dir) => {
    if (seen.has(dir)) return // guard against symlink cycles in exotic fs backends
    seen.add(dir)
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    if (!Array.isArray(entries)) {
      throw new Error(`[compiler] fs.readdirSync(${dir}, { withFileTypes: true }) must return an array`)
    }
    for (const e of entries) {
      if (!e || typeof e.isDirectory !== 'function') {
        throw new Error(`[compiler] fs.readdirSync must return Dirent entries with isDirectory()/isFile() (got ${typeof e} under ${dir})`)
      }
      const full = `${dir}/${e.name}`
      if (e.isDirectory()) walk(full)
      else out[full.slice(prefix.length)] = fs.readFileSync(full, 'utf8')
    }
  }
  walk(prefix.slice(0, -1))
  return out
}

// The sync fs subset the compiler actually calls on the compileMiniApp path.
// readdirSync must additionally support { withFileTypes: true }.
const REQUIRED_FS = [
  'existsSync', 'readFileSync', 'readdirSync', 'statSync',
  'writeFileSync', 'mkdirSync', 'copyFileSync', 'rmSync',
]

function assertFs(fs) {
  if (!fs || typeof fs !== 'object') {
    throw new Error('[compiler] compileMiniApp requires { fs }: inject a node:fs replacement (e.g. createFsFromVolume(memfs Volume)) seeded with the project source under workPath')
  }
  const missing = REQUIRED_FS.filter((m) => typeof fs[m] !== 'function')
  if (missing.length) {
    throw new Error(`[compiler] injected fs is missing required method(s): ${missing.join(', ')}. Needs the sync subset ${REQUIRED_FS.join('/')}, and readdirSync must support { withFileTypes: true }.`)
  }
}

// --- compile stages --------------------------------------------------------
// The three stages read project source and each write their OWN product files;
// no stage reads back another stage's products (verified against the compiler),
// so they can run in any order — or concurrently in separate realms/workers over
// a shared fs. Each function keeps the exact per-stage sequencing of the original
// single-pass compile so output stays byte-for-byte identical.

async function runLogicStage(pages, progress) {
  // Main first (produces mainRes). A subpackage that references a shared component
  // belonging to the main package reverse-injects it into mainRes, so the main
  // package's logic.js must be written LAST — after every subpackage has run.
  const mainRes = await compileJS(pages.mainPages, null, null, progress)
  for (const [root, sub] of Object.entries(pages.subPages)) {
    const subRes = await compileJS(sub.info, root, sub.independent ? [] : mainRes, progress)
    await writeCompileRes(subRes, root)
  }
  await writeCompileRes(mainRes, null)
}

async function runViewStage(pages, progress) {
  await compileML(pages.mainPages, null, progress)
  for (const [root, sub] of Object.entries(pages.subPages)) {
    await compileML(sub.info, root, progress)
  }
}

async function runStyleStage(pages, progress) {
  // app.css is prepended for the main package, matching the original ordering.
  const styleMain = [{ path: 'app', id: '' }, ...pages.mainPages]
  await compileSS(styleMain, null, progress)
  for (const [root, sub] of Object.entries(pages.subPages)) {
    await compileSS(sub.info, root, progress)
  }
}

const STAGES = {
  logic: runLogicStage,
  view: runViewStage,
  style: runStyleStage,
}

/** The compile stages, in the order the single-pass compile runs them. */
export const STAGE_NAMES = Object.keys(STAGES)

/**
 * Run ONE stage's compile functions against whatever fs backend is already active
 * (the fs shim for the memfs path, or native node:fs when this module is bundled
 * without the fs alias for the Node disk pool). Assumes the env singletons are
 * already restored (caller does `resetStoreInfo`). Threads `sourcemap` into the
 * logic stage (view/style have no sourcemap — a dmcc limitation, not ours). Kept
 * separate from `compileStage` so the Node stage worker can drive it directly with
 * native fs, no shim.
 * @param {'logic'|'view'|'style'} stage
 * @param {object} pages
 * @param {{ sourcemap?: boolean }} [opts]
 */
export async function runStage(stage, pages, { sourcemap = false } = {}) {
  const run = STAGES[stage]
  if (!run) throw new Error(`[compiler] unknown compile stage "${stage}" (expected ${STAGE_NAMES.join('/')})`)
  // Only the logic compiler generates sourcemaps; setting it is a harmless no-op for
  // the other stages (they never read enableSourcemap).
  if (stage === 'logic') __setEnableSourcemap(!!sourcemap)
  await run(pages, makeProgress())
}

/**
 * One-time setup against the injected fs: parse config/paths, scaffold the dist
 * dir, compile app-config.json, build npm packages. Returns a SERIALIZABLE
 * context (the storeInfo bundle + page map + ids + targetPath) that each stage
 * restores via `compileStage`. Setup WRITES scaffolding/app-config/npm into the
 * fs, so with a shared fs the stage workers read them without re-running setup.
 * @param {{ fs: object, workPath?: string, options?: object }} opts
 * @returns {Promise<{ storeInfo: object, pages: object, appId: string, name: string, targetPath: string, workPath: string }>}
 */
export async function setupCompile({ fs, workPath = '/work', options = {} } = {}) {
  assertFs(fs)
  // Guarantee a usable appId regardless of whether the project declared one.
  ensureAppIdFs(fs, `${workPath}/project.config.json`)
  setFs(fs)
  try {
    const store = storeInfo(workPath, options)
    createDist()
    compileConfig()
    // findMiniprogramNpmDirs() no-ops (existsSync guard, returns []) when there is
    // no miniprogram_npm, so this only throws on a GENUINE npm build failure.
    try {
      await new NpmBuilder(getWorkPath(), getTargetPath()).buildNpmPackages()
    } catch (e) {
      throw new Error(`[compiler] miniprogram_npm build failed: ${e.message}`)
    }
    return {
      storeInfo: store,
      pages: getPages(),
      appId: getAppId(),
      name: getAppName(),
      targetPath: getTargetPath(),
      workPath,
    }
  } finally {
    resetFs()
  }
}

/**
 * Run ONE compile stage against the injected fs. `pages` and `storeInfo` come
 * from `setupCompile`. Self-contained: it points the fs shim at `fs` and restores
 * the compiler env from the bundle, so it can run in a fresh worker realm.
 * Products are written into `fs`.
 * @param {{ stage: 'logic'|'view'|'style', pages: object, storeInfo: object, fs: object }} opts
 */
export async function compileStage({ stage, pages, storeInfo: bundle, fs, sourcemap = false } = {}) {
  assertFs(fs)
  setFs(fs)
  try {
    resetStoreInfo(bundle)
    await runStage(stage, pages, { sourcemap })
  } finally {
    resetFs()
  }
}

/**
 * Collect the compiled products from the injected fs under `targetPath` into a
 * `{ relPath: content }` map. Uses `fs` directly (no shim), so no setup needed.
 * @param {{ fs: object, targetPath: string }} opts
 * @returns {Record<string,string>}
 */
export function collectOutputs({ fs, targetPath } = {}) {
  return readOutputs(fs, targetPath)
}

/**
 * Clear the compiler's module-level caches so a REUSED realm (e.g. a pooled
 * worker kept warm to amortize wasm-toolchain init) can compile a second project
 * without contamination from the first. The env singletons (pathInfo/configInfo)
 * are overwritten by each setupCompile's storeInfo, so they need no clearing — but
 * these caches are keyed by module/asset path with no appId qualifier and are
 * otherwise never reset on the inline (non-worker) path:
 *   - logic  processedModules — else a shared page path is skipped as "done"
 *   - style  compileRes        — CSS cache
 *   - view   compileResCache / wxsModuleRegistry / wxsFilePathMap
 *   - assets assetsMap         — else a reused path returns a stale uuid and the
 *                                asset copy into the new fs is skipped
 * Call it BEFORE compiling the next project in the same realm.
 */
export function resetCompilerState() {
  __resetLogicState()
  __resetStyleState()
  __resetViewState()
  __resetAssets()
}

// The compiler keeps module-level singletons (env.js pathInfo/configInfo) and the
// fs shim has a single active backend, so two compiles in the same realm must NOT
// overlap. Serialize calls through a promise chain — each waits for the previous
// to settle. Cross-realm callers (separate workers/processes) are already isolated.
let compileChain = Promise.resolve()

/**
 * Compile a mini-program against a caller-injected fs. Calls are serialized per
 * realm (see the singleton note above). Convenience wrapper that runs
 * `setupCompile` + all stages + `collectOutputs` in one realm.
 * @param {{ fs: object, workPath?: string }} opts
 *   fs:       a node:fs replacement (sync subset: existsSync/readFileSync/
 *             readdirSync{withFileTypes}/statSync/writeFileSync/mkdirSync{recursive}/
 *             copyFileSync/rmSync), already seeded with the project source under
 *             `workPath`. The compiler also writes products back into it, and a
 *             missing project.config.json appid is written into it.
 *   workPath: project root inside the fs, default '/work'.
 * @returns {Promise<{ appId: string, name: string, files: Record<string,string> }>}
 */
export function compileMiniApp(opts = {}) {
  const result = compileChain.then(() => runCompile(opts))
  // Keep the chain alive regardless of this call's outcome; the caller still gets
  // the real result/rejection via `result`.
  compileChain = result.then(() => {}, () => {})
  return result
}

async function runCompile({ fs, workPath = '/work' } = {}) {
  const ctx = await setupCompile({ fs, workPath })
  const { storeInfo: bundle, pages, appId, name, targetPath } = ctx
  // Same order as the original single pass. Stages are independent (no product
  // read-back), so the order is not load-bearing — Phase 3 runs them concurrently
  // in separate worker realms over a shared fs.
  await compileStage({ stage: 'logic', pages, storeInfo: bundle, fs })
  await compileStage({ stage: 'view', pages, storeInfo: bundle, fs })
  await compileStage({ stage: 'style', pages, storeInfo: bundle, fs })
  return { appId, name, files: collectOutputs({ fs, targetPath }) }
}
