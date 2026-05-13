#!/usr/bin/env node

/**
 * Build dimina/fe/packages/container and copy dist into
 * packages/devkit/fe/dimina-fe-container/ — devkit's openProject serves
 * that dir as the runtime container, and ships it to npm consumers.
 *
 * Two builds run sequentially:
 *   1. Main build — upstream vite.config.mjs (index.html + pageFrame.html entries)
 *   2. Browser API build — our vite.config.api.js (src/runtime.js as ES module)
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '../..')
const DIMINA_FE = join(ROOT, 'dimina/fe')
const DIMINA_ROOT = join(ROOT, 'dimina')
const CONTAINER_SRC = join(DIMINA_FE, 'packages/container')
const SERVICE_SRC = join(DIMINA_FE, 'packages/service')
const CONTAINER_DIST = join(CONTAINER_SRC, 'dist')
const TARGET_DIST = join(ROOT, 'packages/devkit/fe/dimina-fe-container')
const API_VITE_CONFIG = join(__dirname, 'vite.config.api.js')
const SIMULATOR_DIR = join(__dirname, 'src/simulator')

// Devtools-specific API files to inject into dimina source before building.
// These files are maintained in simulator/service-apis/ instead of upstream dimina.
const INJECTED_FILES = [
  { src: join(SIMULATOR_DIR, 'service-apis/file/index.js'), dest: join(SERVICE_SRC, 'src/api/core/file/index.js') },
  { src: join(SIMULATOR_DIR, 'service-apis/audio/index.js'), dest: join(SERVICE_SRC, 'src/api/core/media/audio/index.js') },
]

// String-level patches applied to upstream dimina source before build, then
// reverted via `git checkout` afterward. Each patch must have a unique `find`
// anchor; build aborts if the anchor is missing (so a rebase upstream loudly
// surfaces a stale patch instead of silently no-op-ing).
const SOURCE_PATCHES = [
  {
    // Upstream f431916 (tabbar PR 4e91eaf) reads this.appInfo.{pagePath,appId,…}
    // on MiniApp but never assigns this.appInfo, so _loadApp throws on first
    // launch and the page iframe never mounts. Alias opts so the field resolves.
    file: join(CONTAINER_SRC, 'src/pages/miniApp/miniApp.js'),
    find: 'this._extSubscriptions = new Map();',
    replace: 'this._extSubscriptions = new Map();\n\t\tthis.appInfo = opts;',
  },
]

function injectFiles() {
  for (const { src, dest } of INJECTED_FILES) {
    mkdirSync(dirname(dest), { recursive: true })
    cpSync(src, dest)
  }
  console.log('Injected devtools API files into dimina source')
}

function cleanupInjectedFiles() {
  for (const { dest } of INJECTED_FILES) {
    const rel = relative(DIMINA_ROOT, dest)
    // If upstream tracks this path, restore the original via git checkout so
    // the submodule doesn't end up with a dirty deletion (e.g. file/index.js
    // is a real upstream file we overwrite, not a new file we add).
    const tracked = spawnSync('git', ['ls-files', '--error-unmatch', rel], {
      cwd: DIMINA_ROOT,
      stdio: 'ignore',
    }).status === 0
    if (tracked) {
      spawnSync('git', ['checkout', '--', rel], { cwd: DIMINA_ROOT })
      continue
    }
    rmSync(dest, { force: true })
    // Remove empty parent directories (for genuinely-new injected files only)
    let dir = dirname(dest)
    while (dir !== SERVICE_SRC && dir !== CONTAINER_SRC) {
      try { rmSync(dir, { recursive: false }); dir = dirname(dir) } catch { break }
    }
  }
  console.log('Cleaned up injected files from dimina source')
}

function applySourcePatches() {
  for (const p of SOURCE_PATCHES) {
    // Reset to a clean baseline so we don't double-patch a stale file from a
    // previous build that died before revert (e.g. ctrl-c, OOM).
    const rel = relative(DIMINA_ROOT, p.file)
    spawnSync('git', ['checkout', '--', rel], { cwd: DIMINA_ROOT })
    const txt = readFileSync(p.file, 'utf8')
    if (!txt.includes(p.find)) {
      throw new Error(`Source patch anchor not found in ${rel}: ${JSON.stringify(p.find)}`)
    }
    writeFileSync(p.file, txt.replace(p.find, p.replace))
  }
  if (SOURCE_PATCHES.length > 0) console.log(`Applied ${SOURCE_PATCHES.length} source patch(es) to dimina`)
}

function revertSourcePatches() {
  for (const p of SOURCE_PATCHES) {
    const rel = relative(DIMINA_ROOT, p.file)
    spawnSync('git', ['checkout', '--', rel], { cwd: DIMINA_ROOT })
  }
  if (SOURCE_PATCHES.length > 0) console.log('Reverted source patches in dimina')
}

function getDiminaGitHash() {
  const gitResult = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: DIMINA_ROOT,
    encoding: 'utf8',
  })

  if (gitResult.status !== 0) {
    return 'unknown'
  }

  return gitResult.stdout.trim() || 'unknown'
}

// Full fingerprint of every input that feeds the container build:
//   - dimina submodule HEAD commit
//   - dimina working-tree dirtiness (git status + diff, so uncommitted
//     upstream edits invalidate the cache even at the same SHA)
//   - build-container.js + vite.config.api.js
//   - every file under src/simulator/service-apis/ (injected into dimina)
// Kept in sync with the CI actions/cache key in .github/workflows/release.yml.
function walkAndHash(root, hash) {
  if (!existsSync(root)) return
  const entries = readdirSync(root).sort()
  for (const name of entries) {
    const full = join(root, name)
    const s = statSync(full)
    if (s.isDirectory()) {
      walkAndHash(full, hash)
    } else if (s.isFile()) {
      hash.update(`${relative(__dirname, full)}\0`)
      hash.update(readFileSync(full))
      hash.update('\0')
    }
  }
}

function getInputFingerprint() {
  const hash = createHash('sha256')
  hash.update(`dimina-sha:${getDiminaGitHash()}\n`)
  const status = spawnSync('git', ['status', '--porcelain'], {
    cwd: DIMINA_ROOT,
    encoding: 'utf8',
  })
  if (status.status === 0 && status.stdout) {
    hash.update(`dimina-status:\n${status.stdout}`)
    const diff = spawnSync('git', ['diff', 'HEAD'], {
      cwd: DIMINA_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
    hash.update(`dimina-diff:\n${diff.stdout ?? ''}`)
    // git diff HEAD misses untracked files; hash their contents too.
    for (const line of status.stdout.split('\n')) {
      if (!line.startsWith('?? ')) continue
      const rel = line.slice(3).trim()
      const full = join(DIMINA_ROOT, rel)
      if (!existsSync(full)) continue
      const s = statSync(full)
      if (s.isDirectory()) walkAndHash(full, hash)
      else if (s.isFile()) {
        hash.update(`dimina-untracked:${rel}\0`)
        hash.update(readFileSync(full))
        hash.update('\0')
      }
    }
  }
  for (const file of ['build-container.js', 'vite.config.api.js']) {
    hash.update(`${file}:\n`)
    hash.update(readFileSync(join(__dirname, file)))
    hash.update('\0')
  }
  walkAndHash(join(SIMULATOR_DIR, 'service-apis'), hash)
  return hash.digest('hex')
}

// Skip the (expensive) Vite builds when TARGET_DIST already holds an
// output stamped for the exact same input fingerprint. Useful in CI when
// actions/cache restores TARGET_DIST, and locally when iterating on code
// outside the container inputs. Set DIMINA_FORCE_BUILD=1 to override.
function isFreshBuild(fingerprint) {
  if (process.env.DIMINA_FORCE_BUILD === '1') return false
  const versionFile = join(TARGET_DIST, 'dimina-version.json')
  if (!existsSync(versionFile)) return false
  try {
    const cached = JSON.parse(readFileSync(versionFile, 'utf8'))
    return cached.inputFingerprint === fingerprint
  } catch {
    return false
  }
}

const inputFingerprint = getInputFingerprint()
if (isFreshBuild(inputFingerprint)) {
  console.log(`Container already built for dimina ${getDiminaGitHash()} (fingerprint ${inputFingerprint.slice(0, 12)}), skipping.`)
  process.exit(0)
}

// 上游 dimina/fe vite 在 GITHUB_ACTIONS 存在时把 base 改成 '/dimina/'
// （他们自己 GH Pages demo 部署路径），会导致 CI 产物里 pageFrame.html
// 和 BASE_URL 都被注入 /dimina/ 前缀，运行时全部 404。我们 container
// 服务挂在根路径，必须清掉这个 env 让上游走 base='/' 分支。
const buildEnv = { ...process.env, GITHUB_ACTIONS: '' }

// Inject + patch + build wrapped in a single try/finally so a failure between
// injectFiles() and the build (e.g. a stale SOURCE_PATCHES anchor that makes
// applySourcePatches throw) still runs cleanup and leaves the submodule clean.
try {
  // 0. Inject devtools API files + apply source patches to dimina source tree
  injectFiles()
  applySourcePatches()

  // 1. Main container build (upstream config, unchanged)
  const mainBuild = spawnSync('pnpm', ['build'], {
    cwd: DIMINA_FE,
    stdio: 'inherit',
    shell: true,
    env: buildEnv,
  })

  if (mainBuild.status !== 0) {
    process.exit(mainBuild.status ?? 1)
  }

  // 2. Browser API build (our config, appends into same dist/)
  const apiBuild = spawnSync(
    'npx', ['vite', 'build', '--config', API_VITE_CONFIG],
    { cwd: CONTAINER_SRC, stdio: 'inherit', shell: true, env: buildEnv },
  )

  if (apiBuild.status !== 0) {
    console.error('Browser API build failed')
    process.exit(apiBuild.status ?? 1)
  }
} finally {
  // Always clean up injected files + revert source patches, even if build fails
  cleanupInjectedFiles()
  revertSourcePatches()
}

// 3. Sync build output into TARGET_DIST. Clear only the entries this build
// actually produces so committed files in TARGET_DIST (.gitignore, favicon.ico,
// images/) are preserved.
mkdirSync(TARGET_DIST, { recursive: true })
for (const entry of readdirSync(CONTAINER_DIST)) {
  rmSync(join(TARGET_DIST, entry), { recursive: true, force: true })
}
cpSync(CONTAINER_DIST, TARGET_DIST, { recursive: true })

const diminaGitHash = getDiminaGitHash()
writeFileSync(
  join(TARGET_DIST, 'dimina-version.json'),
  JSON.stringify({ diminaGitHash, inputFingerprint }, null, 2),
)
// Empty .npmignore overrides the in-tree .gitignore so npm publishes
// the full built container (not just the committed scaffolding).
writeFileSync(join(TARGET_DIST, '.npmignore'), '')
console.log(`Container dist copied to ${TARGET_DIST}`)
console.log(`Referenced dimina hash: ${diminaGitHash}`)
