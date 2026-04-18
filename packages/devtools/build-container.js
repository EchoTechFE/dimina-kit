#!/usr/bin/env node

/**
 * Build dimina/fe/packages/container and copy dist to this package's container/ directory.
 *
 * Two builds run sequentially:
 *   1. Main build — upstream vite.config.mjs (index.html + pageFrame.html entries)
 *   2. Browser API build — our vite.config.api.js (src/runtime.js as ES module)
 *
 * Output is placed in container/ so it can be bundled with the published package.
 */

import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '../..')
const DIMINA_FE = join(ROOT, 'dimina/fe')
const DIMINA_ROOT = join(ROOT, 'dimina')
const CONTAINER_SRC = join(DIMINA_FE, 'packages/container')
const SERVICE_SRC = join(DIMINA_FE, 'packages/service')
const CONTAINER_DIST = join(CONTAINER_SRC, 'dist')
const TARGET_DIST = join(__dirname, 'container')
const API_VITE_CONFIG = join(__dirname, 'vite.config.api.js')
const SIMULATOR_DIR = join(__dirname, 'src/simulator')

// Devtools-specific API files to inject into dimina source before building.
// These files are maintained in simulator/service-apis/ instead of upstream dimina.
const INJECTED_FILES = [
  { src: join(SIMULATOR_DIR, 'service-apis/file/index.js'), dest: join(SERVICE_SRC, 'src/api/core/file/index.js') },
  { src: join(SIMULATOR_DIR, 'service-apis/audio/index.js'), dest: join(SERVICE_SRC, 'src/api/core/media/audio/index.js') },
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
    rmSync(dest, { force: true })
    // Remove empty parent directories
    let dir = dirname(dest)
    while (dir !== SERVICE_SRC && dir !== CONTAINER_SRC) {
      try { rmSync(dir, { recursive: false }); dir = dirname(dir) } catch { break }
    }
  }
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

// 0. Inject devtools API files into dimina source tree
injectFiles()

try {
  // 1. Main container build (upstream config, unchanged)
  const mainBuild = spawnSync('pnpm', ['build'], {
    cwd: DIMINA_FE,
    stdio: 'inherit',
    shell: true,
  })

  if (mainBuild.status !== 0) {
    process.exit(mainBuild.status ?? 1)
  }

  // 2. Browser API build (our config, appends into same dist/)
  const apiBuild = spawnSync(
    'npx', ['vite', 'build', '--config', API_VITE_CONFIG],
    { cwd: CONTAINER_SRC, stdio: 'inherit', shell: true },
  )

  if (apiBuild.status !== 0) {
    console.error('Browser API build failed')
    process.exit(apiBuild.status ?? 1)
  }
} finally {
  // Always clean up injected files, even if build fails
  cleanupInjectedFiles()
}

// 3. Copy dist to container/
rmSync(TARGET_DIST, { recursive: true, force: true })
cpSync(CONTAINER_DIST, TARGET_DIST, { recursive: true })

const diminaGitHash = getDiminaGitHash()
writeFileSync(
  join(TARGET_DIST, 'dimina-version.json'),
  JSON.stringify({ diminaGitHash }, null, 2),
)
writeFileSync(join(TARGET_DIST, '.npmignore'), '')
console.log(`Container dist copied to ${TARGET_DIST}`)
console.log(`Referenced dimina hash: ${diminaGitHash}`)
