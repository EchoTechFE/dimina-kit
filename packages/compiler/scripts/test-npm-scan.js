// Regression tests: the miniprogram_npm scan that feeds compiled output must mirror
// the npm addressing authority (NpmResolver), which only ever walks UP from a compiled
// source file's own directory looking for a miniprogram_npm sibling. A miniprogram_npm
// dir that sits inside node_modules/, inside a dot-directory, or inside an output dir
// nested within the project is never reachable that way and must not appear in the
// compiled product — while one at the project root, a subpackage root, or anywhere on
// a page's ancestor chain (all real addressing positions) must still come through.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Volume, createFsFromVolume } from 'memfs'
import { compileMiniApp } from '../dist/compile-core.node.js'

const WP = '/work'
const BASE = {
  'app.js': 'App({})',
  'app.json': JSON.stringify({ pages: ['pages/index'] }),
  'pages/index.js': 'Page({})',
  'pages/index.wxml': '<view>hi</view>',
}
const volOf = (files) => Volume.fromJSON(files, WP)
const fsOf = (files) => createFsFromVolume(volOf(files))

// A minimal npm package under `${npmDirPath}/${pkgName}` — just enough for
// findMiniprogramNpmDirs/buildPackage to see a real package.
const npmPackage = (npmDirPath, pkgName) => ({
  [`${npmDirPath}/${pkgName}/index.js`]: 'module.exports = 1',
  [`${npmDirPath}/${pkgName}/package.json`]: JSON.stringify({ name: pkgName, version: '1.0.0' }),
})

const hasPrefixKey = (files, prefix) => Object.keys(files).some((k) => k.startsWith(prefix))
const hasSubstringKey = (files, needle) => Object.keys(files).some((k) => k.includes(needle))

let pass = 0
let fail = 0
const check = async (label, fn) => {
  try { await fn(); console.log(`  ✅ ${label}`); pass++ }
  catch (e) { console.error(`  ❌ ${label}\n       ${e.message}`); fail++ }
}

// #1 — the project-root miniprogram_npm is a real addressing position (the fallback
// every compiled source file resolves to once it walks past its own package roots).
await check('root miniprogram_npm package reaches the output', async () => {
  const files = { ...BASE, ...npmPackage('miniprogram_npm', 'foo') }
  const r = await compileMiniApp({ fs: fsOf(files), workPath: WP })
  assert.ok(
    hasPrefixKey(r.files, 'miniprogram_npm/foo/'),
    `expected a miniprogram_npm/foo/ file in the output, got: ${Object.keys(r.files).join(', ')}`,
  )
})

// #2 — a subpackage root's own miniprogram_npm is a real addressing position for
// source files compiled under that subpackage.
await check('subpackage-root miniprogram_npm package reaches the output', async () => {
  const files = {
    ...BASE,
    'app.json': JSON.stringify({
      pages: ['pages/index'],
      subPackages: [{ root: 'sub', pages: ['pages/a'] }],
    }),
    'sub/pages/a.js': 'Page({})',
    'sub/pages/a.wxml': '<view>a</view>',
    ...npmPackage('sub/miniprogram_npm', 'bar'),
  }
  const r = await compileMiniApp({ fs: fsOf(files), workPath: WP })
  assert.ok(
    hasPrefixKey(r.files, 'sub/miniprogram_npm/bar/'),
    `expected a sub/miniprogram_npm/bar/ file in the output, got: ${Object.keys(r.files).join(', ')}`,
  )
})

// #3 — any layer on a page's ancestor chain (here pages/miniprogram_npm, an ancestor
// of pages/index.js) is a real addressing position too.
await check('page-ancestor-chain miniprogram_npm package reaches the output', async () => {
  const files = { ...BASE, ...npmPackage('pages/miniprogram_npm', 'baz') }
  const r = await compileMiniApp({ fs: fsOf(files), workPath: WP })
  assert.ok(
    hasPrefixKey(r.files, 'pages/miniprogram_npm/baz/'),
    `expected a pages/miniprogram_npm/baz/ file in the output, got: ${Object.keys(r.files).join(', ')}`,
  )
})

// #4 — no compiled source file's upward walk ever passes through node_modules, so a
// miniprogram_npm nested inside it can never be a real addressing position.
await check('miniprogram_npm nested under node_modules is excluded from the output', async () => {
  const files = { ...BASE, ...npmPackage('node_modules/some-pkg/miniprogram_npm', 'junk') }
  const r = await compileMiniApp({ fs: fsOf(files), workPath: WP })
  assert.ok(
    !hasSubstringKey(r.files, 'node_modules/'),
    `output leaked a node_modules/ path: ${Object.keys(r.files).filter((k) => k.includes('node_modules/')).join(', ')}`,
  )
})

// #5 — dot-directories (.git, e2e snapshot dirs, …) are never on a compiled source
// file's own path, so a miniprogram_npm nested inside one is unaddressable.
await check('miniprogram_npm nested under a dot-directory is excluded from the output', async () => {
  const files = { ...BASE, ...npmPackage('.snapshots/deep/miniprogram_npm', 'junk') }
  const r = await compileMiniApp({ fs: fsOf(files), workPath: WP })
  const leaked = Object.keys(r.files).filter((k) => k.startsWith('.snapshots/') || k.includes('/.snapshots/'))
  assert.equal(leaked.length, 0, `output leaked dot-directory path(s): ${leaked.join(', ')}`)
})

// --- #6: an in-project output dir must not feed back into the next build's scan -----
// Real-disk helpers (createNodeCompilerPool writes to native fs, not memfs).
function writeProjectFile(root, relPath, content) {
  const full = path.join(root, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content)
}
function writeProject(root, files) {
  for (const [rel, content] of Object.entries(files)) writeProjectFile(root, rel, content)
}
function readTree(root) {
  const out = {}
  const walk = (dir, rel) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name)
      const r = rel ? `${rel}/${name}` : name
      if (fs.statSync(full).isDirectory()) walk(full, r)
      else out[r] = fs.readFileSync(full, 'utf8')
    }
  }
  walk(root, '')
  return out
}

await check('a project-internal output dir is not re-scanned as npm input on the next build (no compounding nesting)', async () => {
  const { createNodeCompilerPool } = await import('../dist/pool.node.js')
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dmcc-npm-scan-'))
  const pool = createNodeCompilerPool()
  try {
    writeProject(tmpRoot, { ...BASE, ...npmPackage('miniprogram_npm', 'foo') })
    // outputDir lives INSIDE the project — exactly the "caller set outputDir in the
    // project" case that must not let build N's own output feed build N+1's npm scan.
    const outputDir = path.join(tmpRoot, 'dist')

    const info1 = await pool.build(outputDir, tmpRoot, true, {})
    const tree1 = readTree(path.join(outputDir, info1.appId))

    const info2 = await pool.build(outputDir, tmpRoot, true, {})
    const tree2 = readTree(path.join(outputDir, info2.appId))

    const nestedDist = Object.keys(tree2).filter((k) => k.split('/').includes('dist'))
    assert.equal(
      nestedDist.length,
      0,
      `second build's output contains a nested dist/ subtree — the first build's own `
      + `output was re-scanned as npm input: ${nestedDist.slice(0, 5).join(', ')}`,
    )
    assert.deepEqual(
      Object.keys(tree1).sort(),
      Object.keys(tree2).sort(),
      'output file set must be identical across repeated builds of an unchanged project',
    )
  } finally {
    await pool.dispose()
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
})

console.log(`\n${'─'.repeat(56)}\nResults: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
console.log('All npm-scan assertions passed.')
