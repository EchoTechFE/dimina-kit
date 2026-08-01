#!/usr/bin/env node

/**
 * Build dimina/fe/packages/container and copy dist into
 * packages/devkit/fe/dimina-fe-container/ — devkit's openProject serves
 * that dir as the runtime container, and ships it to npm consumers.
 *
 * The upstream vite.config.mjs build (index.html + pageFrame.html + the
 * service/render/common bundles native-host loads) runs unchanged.
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
const SIMULATOR_DIR = join(__dirname, 'src/simulator')

// Devtools-specific API files to inject into dimina source before building.
// These files are maintained in simulator/service-apis/ instead of upstream dimina.
// `preserveOriginalAs`: before the overlay lands on `dest`, the upstream
// original is copied to this sibling path so the overlay can import and
// delegate to it (the file shim re-exports upstream's async FSM surface).
const INJECTED_FILES = [
  {
    src: join(SIMULATOR_DIR, 'service-apis/file/index.js'),
    dest: join(SERVICE_SRC, 'src/api/core/file/index.js'),
    preserveOriginalAs: join(SERVICE_SRC, 'src/api/core/file/upstream-impl.js'),
  },
  { src: join(SIMULATOR_DIR, 'service-apis/audio/index.js'), dest: join(SERVICE_SRC, 'src/api/core/media/audio/index.js') },
  { src: join(SIMULATOR_DIR, 'service-apis/network/upload/index.js'), dest: join(SERVICE_SRC, 'src/api/core/network/upload/index.js') },
  { src: join(SIMULATOR_DIR, 'service-apis/network/websocket/index.js'), dest: join(SERVICE_SRC, 'src/api/core/network/websocket/index.js') },
]

// Transaction journal for the injected-file overlay: one entry per path this
// run has actually TOUCHED, recorded before mutating it. Cleanup restores
// journal entries only (in reverse order) — iterating INJECTED_FILES there
// instead would conflate "never processed" with "did not exist" and delete
// upstream files a mid-loop injection failure never touched.
const injectionJournal = []

function injectFiles() {
  for (const { src, dest, preserveOriginalAs } of INJECTED_FILES) {
    // A leftover backup file means a previous injected build never cleaned
    // up (crash/kill between inject and cleanup). Copying the current dest
    // over it would capture the OVERLAY as the "upstream original" and the
    // shim would then delegate to itself — fail loudly instead.
    if (preserveOriginalAs && existsSync(preserveOriginalAs)) {
      throw new Error(
        `${preserveOriginalAs} already exists — a previous injected build did not clean up. ` +
          `Restore the dimina submodule (e.g. \`git -C dimina checkout -- fe/\` and remove the leftover file) before rebuilding.`,
      )
    }
    if (preserveOriginalAs && !existsSync(dest)) {
      throw new Error(
        `cannot preserve ${dest} as ${preserveOriginalAs}: the upstream original is missing`,
      )
    }
    const entry = { dest, backup: existsSync(dest) ? readFileSync(dest) : null, preserveOriginalAs }
    mkdirSync(dirname(dest), { recursive: true })
    injectionJournal.push(entry)
    if (preserveOriginalAs) {
      cpSync(dest, preserveOriginalAs)
    }
    cpSync(src, dest)
  }
  console.log('Injected devtools API files into dimina source')
}

function cleanupInjectedFiles() {
  for (const { dest, backup, preserveOriginalAs } of [...injectionJournal].reverse()) {
    if (preserveOriginalAs) {
      rmSync(preserveOriginalAs, { force: true })
    }
    // Restore the exact pre-build bytes rather than `git checkout`: a feature
    // worktree may intentionally have uncommitted edits in an upstream file
    // that devtools temporarily overlays (notably websocket/index.js).
    if (backup !== null) {
      writeFileSync(dest, backup)
      continue
    }
    rmSync(dest, { force: true })
    // Remove empty parent directories (for genuinely-new injected files only)
    let dir = dirname(dest)
    while (dir !== SERVICE_SRC && dir !== CONTAINER_SRC) {
      try { rmSync(dir, { recursive: false }); dir = dirname(dir) } catch { break }
    }
  }
  injectionJournal.length = 0
  console.log('Cleaned up injected files from dimina source')
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
//   - build-container.js
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
  for (const file of ['build-container.js']) {
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

// The dimina submodule must be populated before we spawn `pnpm build` with
// cwd=DIMINA_FE: if package.json is missing there (fresh clone / fresh git
// worktree without `git submodule update --init`), pnpm walks UP the directory
// tree, finds the monorepo root, and runs the root `turbo run build` — which
// re-enters this script and recurses without bound until the machine OOMs.
if (!existsSync(join(DIMINA_FE, 'package.json'))) {
  console.error(
    `dimina submodule is not initialized (${join(DIMINA_FE, 'package.json')} missing).\n` +
      'Run `git submodule update --init dimina` first.',
  )
  process.exit(1)
}

// 上游 dimina/fe vite 在 GITHUB_ACTIONS 存在时把 base 改成 '/dimina/'
// （他们自己 GH Pages demo 部署路径），会导致 CI 产物里 pageFrame.html
// 和 BASE_URL 都被注入 /dimina/ 前缀，运行时全部 404。我们 container
// 服务挂在根路径，必须清掉这个 env 让上游走 base='/' 分支。
const buildEnv = { ...process.env, GITHUB_ACTIONS: '' }

// Inject + build wrapped in try/finally so cleanup always runs and leaves the
// submodule clean even if the build fails. `process.exit()` terminates
// without unwinding a pending `finally`, so the failure status is carried out
// of the try and acted on only AFTER cleanup has restored the submodule.
let buildFailureStatus = null
try {
  injectFiles()

  // Main container build (upstream config, unchanged)
  const mainBuild = spawnSync('pnpm', ['build'], {
    cwd: DIMINA_FE,
    stdio: 'inherit',
    shell: true,
    env: buildEnv,
  })

  if (mainBuild.status !== 0) {
    buildFailureStatus = mainBuild.status ?? 1
  }
} finally {
  cleanupInjectedFiles()
}

if (buildFailureStatus !== null) {
  process.exit(buildFailureStatus)
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
