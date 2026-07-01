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
  storeInfo, getPages, getAppId, getAppName, getWorkPath, getTargetPath,
} from '../../../dimina/fe/packages/compiler/src/env.js'
import { createDist } from '../../../dimina/fe/packages/compiler/src/common/publish.js'
import { compileConfig } from '../../../dimina/fe/packages/compiler/src/core/index.js'
import { NpmBuilder } from '../../../dimina/fe/packages/compiler/src/common/npm-builder.js'
// compileJS exported by source; writeCompileRes export appended at bundle time
import { compileJS, writeCompileRes } from '../../../dimina/fe/packages/compiler/src/core/logic-compiler.js'
// compileML export appended at bundle time
import { compileML } from '../../../dimina/fe/packages/compiler/src/core/view-compiler.js'
import { compileSS } from '../../../dimina/fe/packages/compiler/src/core/style-compiler.js'

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
      throw new Error(`[web-compiler] ${configPath} is not valid JSON; refusing to overwrite it`)
    }
    if (config === null || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error(`[web-compiler] ${configPath} must be a JSON object`)
    }
  }
  const { appid } = config
  if (appid !== undefined && appid !== '' && typeof appid !== 'string') {
    throw new Error(`[web-compiler] ${configPath} "appid" must be a non-empty string`)
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
      throw new Error(`[web-compiler] fs.readdirSync(${dir}, { withFileTypes: true }) must return an array`)
    }
    for (const e of entries) {
      if (!e || typeof e.isDirectory !== 'function') {
        throw new Error(`[web-compiler] fs.readdirSync must return Dirent entries with isDirectory()/isFile() (got ${typeof e} under ${dir})`)
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
    throw new Error('[web-compiler] compileMiniApp requires { fs }: inject a node:fs replacement (e.g. createFsFromVolume(memfs Volume)) seeded with the project source under workPath')
  }
  const missing = REQUIRED_FS.filter((m) => typeof fs[m] !== 'function')
  if (missing.length) {
    throw new Error(`[web-compiler] injected fs is missing required method(s): ${missing.join(', ')}. Needs the sync subset ${REQUIRED_FS.join('/')}, and readdirSync must support { withFileTypes: true }.`)
  }
}

// The compiler keeps module-level singletons (env.js pathInfo/configInfo) and the
// fs shim has a single active backend, so two compiles in the same realm must NOT
// overlap. Serialize calls through a promise chain — each waits for the previous
// to settle. Cross-realm callers (separate workers/processes) are already isolated.
let compileChain = Promise.resolve()

/**
 * Compile a mini-program against a caller-injected fs. Calls are serialized per
 * realm (see the singleton note above).
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
  assertFs(fs)

  // Guarantee a usable appId regardless of whether the project declared one.
  ensureAppIdFs(fs, `${workPath}/project.config.json`)

  // Point the compiler's fs shim at this backend for the duration of the compile.
  setFs(fs)
  try {
    // 1. collect config / paths
    storeInfo(workPath)
    // 2. prepare dist dir, compile app-config.json
    createDist()
    compileConfig()
    // 3. npm packages. findMiniprogramNpmDirs() no-ops (existsSync guard, returns
    // []) when there's no miniprogram_npm, so this only throws on a GENUINE npm
    // build failure — surface it instead of silently shipping missing deps.
    try {
      await new NpmBuilder(getWorkPath(), getTargetPath()).buildNpmPackages()
    } catch (e) {
      throw new Error(`[web-compiler] miniprogram_npm build failed: ${e.message}`)
    }

    const pages = getPages()
    const progress = makeProgress()

    // --- logic (logic.js) ---
    const mainRes = await compileJS(pages.mainPages, null, null, progress)
    for (const [root, sub] of Object.entries(pages.subPages)) {
      const subRes = await compileJS(sub.info, root, sub.independent ? [] : mainRes, progress)
      await writeCompileRes(subRes, root)
    }
    await writeCompileRes(mainRes, null)

    // --- view ({page}.js) ---
    await compileML(pages.mainPages, null, progress)
    for (const [root, sub] of Object.entries(pages.subPages)) {
      await compileML(sub.info, root, progress)
    }

    // --- style ({page}.css + app.css), app prepended for main like the original ---
    const styleMain = [{ path: 'app', id: '' }, ...pages.mainPages]
    await compileSS(styleMain, null, progress)
    for (const [root, sub] of Object.entries(pages.subPages)) {
      await compileSS(sub.info, root, progress)
    }

    // --- collect outputs from the injected fs (under targetPath) ---
    return {
      appId: getAppId(),
      name: getAppName(),
      files: readOutputs(fs, getTargetPath()),
    }
  } finally {
    resetFs()
  }
}
