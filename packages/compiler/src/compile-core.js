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
// __resetAssets appended at bundle time (clears the never-cleared assetsMap cache)
import { __resetAssets } from '../../../dimina/fe/packages/compiler/src/common/utils.js'

// --- lazy per-stage toolchain loading ---------------------------------------
//
// The three stage compilers are loaded on demand, NOT statically: each one drags a
// heavy toolchain behind it (style: sass + cssnano + less + postcss ≈ 150MB RSS per
// realm; view: cheerio + @vue/compiler-sfc; logic: esbuild + oxc), and every realm
// that imports this module — the pool's main thread AND each worker_threads stage
// worker, each with its own isolated module registry — would otherwise pay for ALL
// of them while using at most one. Deferring the import keeps every realm loaded
// with exactly its own stage's toolchain (setupCompile's own chain — config-compiler,
// NpmBuilder, env/publish/utils — is all light, so the main thread loads none).
//
// NOTE for bundling: this only stays lazy if the dynamic imports become real runtime
// chunks. scripts/build-compiler.js builds the node bundles with esbuild `splitting`
// for exactly that reason — a single-file bundle would hoist each chunk's external
// `import 'sass'` back to the entry's top level and silently defeat the laziness.
//
// The per-stage export surfaces (compileJS/writeCompileRes/__reset*/__setEnableSourcemap
// are partly appended at bundle time — see build-compiler.js exportAppend):
//   logic: compileJS, writeCompileRes, __resetLogicState, __setEnableSourcemap
//   view:  compileML, __resetViewState
//   style: compileSS, __resetStyleState
const STAGE_IMPORTERS = {
  logic: () => import('../../../dimina/fe/packages/compiler/src/core/logic-compiler.js'),
  view: () => import('../../../dimina/fe/packages/compiler/src/core/view-compiler.js'),
  style: () => import('../../../dimina/fe/packages/compiler/src/core/style-compiler.js'),
}
const stageLoads = new Map()   // stage -> in-flight/settled import promise
const stageModules = new Map() // stage -> SETTLED module namespace (reset targets)

function loadStageModule(stage) {
  if (!stageLoads.has(stage)) {
    // Only a SUCCESSFUL load is memoized. A rejection (missing chunk, transient fs
    // error) clears the memo so the next call re-imports — a repaired install
    // recovers in place instead of replaying the cached failure forever.
    const load = STAGE_IMPORTERS[stage]().then((m) => {
      stageModules.set(stage, m)
      return m
    }, (err) => {
      if (stageLoads.get(stage) === load) stageLoads.delete(stage)
      throw err
    })
    stageLoads.set(stage, load)
  }
  return stageLoads.get(stage)
}

/**
 * Warm ONE stage's toolchain ahead of its first compile (e.g. a stage worker that
 * knows its identity at spawn). Memoized; a failure surfaces again on the first
 * compile's own load, so callers may fire-and-forget.
 * @param {'logic'|'view'|'style'} stage
 */
export function preloadStage(stage) {
  if (!STAGE_IMPORTERS[stage]) {
    return Promise.reject(new Error(`[compiler] unknown compile stage "${stage}" (expected ${STAGE_NAMES.join('/')})`))
  }
  return loadStageModule(stage).then(() => {})
}

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

// --- miniprogram_npm scan scope -------------------------------------------
//
// Why this exists — the builder's and the resolver's search spaces must agree.
//
// dmcc's NpmBuilder mirrors every directory literally named `miniprogram_npm`
// it can find into the output, preserving each dir's project-relative path. Its
// own findMiniprogramNpmDirs walks the WHOLE project tree with zero exclusions:
// node_modules, hidden directories (.git, test snapshots), and build outputs
// that happen to live inside the project are all scanned, and any
// miniprogram_npm buried in them is faithfully copied into the product.
//
// The consumer of those copies is NpmResolver, and it defines what is actually
// reachable: when a compiled source file imports a bare package name, the
// resolver probes `<ancestor>/miniprogram_npm` walking UP from the importing
// file's directory to the project root (WeChat's npm addressing). Compiled
// sources only ever live in the real source tree, so a miniprogram_npm sitting
// under node_modules, under a dot-directory, or inside a previous build's
// output can never appear on any lookup chain — copying it is pure junk output,
// and dropping it can never break resolution.
//
// The unexcluded scan is worse than bloat: when the caller publishes the output
// INSIDE the project (outputDir under workPath), the next build scans the
// previous build's published npm copies and re-copies them one level deeper —
// dist/<appId>/dist/<appId>/… grows without bound, one level per build, until
// path length blows past the OS limit (ENAMETOOLONG) and publishing crashes.
// Test-artifact snapshots that embed old outputs (e.g. an e2e-captured user-data
// dir committed into the project) feed the same loop.
//
// The fix lives HERE, not in dmcc: the dimina/ submodule is vendored read-only,
// and setupCompile below is the single place this package instantiates the
// builder — overriding the scan at that seam fixes every consumer (memfs
// compileMiniApp, browser pool, Node disk pool) without forking upstream.
//
// Scan rules, each mirroring a resolver invariant — and each matching WeChat's
// own packaging behavior (developers.weixin.qq.com/miniprogram/dev/devtools/npm.html):
//   - skip `node_modules`: it holds RAW npm inputs; miniprogram_npm is their
//     built counterpart, and the resolver never looks inside node_modules.
//     WeChat states it outright: node_modules 目录不会参与编译、上传和打包中.
//   - skip dot-directories: hidden dirs are never mini-program source, so no
//     importing file (and hence no lookup chain) can originate there. This is
//     also what keeps .git and e2e user-data snapshots out. WeChat's packager
//     likewise drops dot-prefixed entries from preview/upload by default.
//   - skip `excludeRoots` subtrees: the staging dir plus any caller-declared
//     publish target (see npmScanExclude) — a build's own output must never
//     become a later build's input, which is exactly the nesting feedback loop.
// Everything else — project root, subpackage roots, any ancestor level of a
// source file — is kept, byte-for-byte where dmcc would have put it. Keeping
// every non-excluded level is deliberate: WeChat generates one miniprogram_npm
// per package.json (so subpackage roots are legitimate), and packNpmRelationList
// / miniprogramNpmDistDir let projects place it at ARBITRARY directories — a
// root-only allowlist would over-filter valid projects.
// scripts/test-npm-scan.js pins both directions (kept and excluded).
//
// Evidence backing the rules above (WeChat official docs + field reports):
//   - npm addressing (upward, per-ancestor miniprogram_npm), per-package.json
//     placement, packNpmRelationList/miniprogramNpmDistDir custom targets, and
//     the node_modules exclusion quote all come from
//     https://developers.weixin.qq.com/miniprogram/dev/devtools/npm.html
//   - dot-prefixed entries are dropped from preview/upload by default; the
//     packOptions prefix/folder ignore rules target exactly this class:
//     https://developers.weixin.qq.com/miniprogram/dev/devtools/projectconfig.html
//   - WeChat performs NO whole-tree scan for miniprogram_npm at all — it
//     GENERATES the dir from package.json/node_modules and packs by dependency
//     analysis, so output-recursion is structurally impossible there. The
//     whole-tree walk is dmcc's own approximation of that pipeline; these
//     exclusions restore the boundaries the approximation dropped.
//
// Uses the caller-injected fs directly (the same backend the rest of setup runs
// against), not the module-level fs the parent class closes over.
function findScopedNpmDirs(fs, workPath, excludeRoots) {
  // Normalized to trailing-slash prefixes so `${dir}/` startsWith covers both
  // the excluded root itself and everything below it.
  const excluded = excludeRoots
    .filter(Boolean)
    .map((p) => (p.endsWith('/') ? p : `${p}/`))
  const npmDirs = []
  const walk = (dir, rel) => {
    if (!fs.existsSync(dir)) return
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!item.isDirectory()) continue
      const { name } = item
      if (name === 'node_modules' || name.startsWith('.')) continue
      const full = `${dir}/${name}`
      if (excluded.some((ex) => `${full}/`.startsWith(ex))) continue
      const childRel = rel ? `${rel}/${name}` : name
      // A found miniprogram_npm is recorded but NOT descended into — package
      // contents are the copy step's job, matching dmcc's own scan shape.
      if (name === 'miniprogram_npm') npmDirs.push(childRel)
      else walk(full, childRel)
    }
  }
  walk(workPath.endsWith('/') ? workPath.slice(0, -1) : workPath, '')
  return npmDirs
}

// NpmBuilder with ONLY the discovery step replaced by the scoped scan above.
// Copy layout, package-json dependency chasing, and the file-type filter are
// inherited unchanged, so for every legitimate miniprogram_npm dir the output
// stays dmcc-identical — the override narrows WHICH dirs ship, never HOW.
class ScopedNpmBuilder extends NpmBuilder {
  constructor(workPath, targetPath, { fs, excludeRoots }) {
    super(workPath, targetPath)
    this._fs = fs
    this._excludeRoots = excludeRoots
  }

  findMiniprogramNpmDirs() {
    return findScopedNpmDirs(this._fs, this.workPath, this._excludeRoots)
  }
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
  const { compileJS, writeCompileRes } = await loadStageModule('logic')
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
  const { compileML } = await loadStageModule('view')
  await compileML(pages.mainPages, null, progress)
  for (const [root, sub] of Object.entries(pages.subPages)) {
    await compileML(sub.info, root, progress)
  }
}

async function runStyleStage(pages, progress) {
  const { compileSS } = await loadStageModule('style')
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
  // Only the logic compiler owns a sourcemap switch (view/style never read it), so the
  // flag lives on the lazily-loaded logic module and is set right before its stage runs.
  if (stage === 'logic') (await loadStageModule('logic')).__setEnableSourcemap(!!sourcemap)
  await run(pages, makeProgress())
}

/**
 * One-time setup against the injected fs: parse config/paths, scaffold the dist
 * dir, compile app-config.json, build npm packages. Returns a SERIALIZABLE
 * context (the storeInfo bundle + page map + ids + targetPath) that each stage
 * restores via `compileStage`. Setup WRITES scaffolding/app-config/npm into the
 * fs, so with a shared fs the stage workers read them without re-running setup.
 * @param {{ fs: object, workPath?: string, options?: object, npmScanExclude?: string[] }} opts
 *   npmScanExclude: absolute directory paths whose subtrees the miniprogram_npm
 *   scan must skip — pass the publish outputDir here when it can sit inside the
 *   project, so a previous build's published output is never re-ingested as npm
 *   input. The staging dir (getTargetPath) is always excluded.
 * @returns {Promise<{ storeInfo: object, pages: object, appId: string, name: string, targetPath: string, workPath: string }>}
 */
export async function setupCompile({ fs, workPath = '/work', options = {}, npmScanExclude = [] } = {}) {
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
      await new ScopedNpmBuilder(getWorkPath(), getTargetPath(), {
        fs,
        excludeRoots: [getTargetPath(), ...npmScanExclude],
      }).buildNpmPackages()
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
  // Only stage modules that actually LOADED in this realm carry cache state; a stage
  // that never loaded (lazy per-stage toolchains) has nothing to clear, and resetting
  // must never force-load a toolchain this realm doesn't use. A module still mid-load
  // is equally safe to skip: its caches are born empty.
  const STAGE_RESETS = { logic: '__resetLogicState', view: '__resetViewState', style: '__resetStyleState' }
  for (const [stage, mod] of stageModules) mod[STAGE_RESETS[stage]]()
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
