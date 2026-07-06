// Equivalence test for the resident Node disk pool (dist/pool.node.js) vs real dmcc.
//
// dmcc output is not byte-deterministic: scoped data-v ids, esbuild variable naming, and
// uuid-prefixed asset file names all vary run-to-run — dmcc's own two runs of the same
// project differ on those. So we run dmcc TWICE to learn:
//   • which files are deterministically NAMED (present under the same name in both runs)
//   • which of those are deterministic in CONTENT (byte-identical across the two runs)
// and require our pool to match dmcc only where dmcc matches itself. Assets (uuid-named)
// are matched by CONTENT hash multiset instead of name. Sourcemap is asserted against
// dmcc's own map (parity), since that is the format devtools already consumes.
import { readdirSync, readFileSync, statSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import path from 'node:path'

const APP = process.env.APP_DIR
  || fileURLToPath(new URL('../../../dimina/fe/example/base', import.meta.url))

const TMP = fileURLToPath(new URL('../.tmp-pool-node/', import.meta.url))
rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })
const dir = (n) => path.join(TMP, n)
const sha = (buf) => createHash('sha256').update(buf).digest('hex')
const multiset = (arr) => { const m = {}; for (const x of arr) m[x] = (m[x] || 0) + 1; return m }
const eqMultiset = (a, b) => {
  const ka = Object.keys(a); const kb = Object.keys(b)
  return ka.length === kb.length && ka.every((k) => a[k] === b[k])
}

function readTree(root) {
  const out = {}
  const walk = (d, rel) => {
    for (const name of readdirSync(d)) {
      const full = path.join(d, name)
      const r = rel ? `${rel}/${name}` : name
      if (statSync(full).isDirectory()) walk(full, r)
      else out[r] = readFileSync(full) // Buffer — byte-exact, binary-safe
    }
  }
  walk(root, '')
  return out
}

const dmccBuild = (await import('../../../dimina/fe/packages/compiler/src/index.js')).default
const poolNodeModule = await import('../dist/pool.node.js')
const { createNodeCompilerPool } = poolNodeModule
// Destructured lazily below (may be absent pre-fix): the default drop-in build(),
// the pure oxc-native-binding-hint mapper, and the lazy-singleton disposer.
const defaultBuild = poolNodeModule.default
const { oxcNativeBindingHint, disposeDefaultPool } = poolNodeModule

// --- reference: dmcc twice ------------------------------------------------
console.log(`[ref] dmcc build ×2 (sourcemap) from ${APP}`)
const appInfoRefA = await dmccBuild(dir('refA'), APP, true, { sourcemap: true })
await dmccBuild(dir('refB'), APP, true, { sourcemap: true })
const appId = appInfoRefA.appId
const refA = readTree(path.join(dir('refA'), appId))
const refB = readTree(path.join(dir('refB'), appId))

// Classify dmcc's files. detName: same name in both runs. detContent: byte-identical too.
const detName = Object.keys(refA).filter((f) => f in refB).sort()
const detContent = detName.filter((f) => refA[f].equals(refB[f]))
const nondetNamed = Object.keys(refA).filter((f) => !(f in refB)) // uuid-named assets
const refAssetHashes = multiset(nondetNamed.map((f) => sha(refA[f])))
if (!(refA['main/logic.js.map'])) throw new Error('test setup: dmcc reference did not emit logic.js.map')
const refMap = JSON.parse(refA['main/logic.js.map'].toString('utf8'))
console.log(`[ref] ${Object.keys(refA).length} files — ${detName.length} deterministically named, `
  + `${detContent.length} byte-deterministic, ${nondetNamed.length} uuid-named assets`)

let failed = false
const fail = (m) => { failed = true; console.error(`❌ ${m}`) }

// The full dmcc-equivalence bar, applied to any of our builds.
function checkAgainstDmcc(tree, label) {
  const total = Object.keys(tree).length
  if (total !== Object.keys(refA).length) fail(`[${label}] file count ${total} != dmcc ${Object.keys(refA).length}`)
  // every deterministically-named dmcc file must exist
  const miss = detName.filter((f) => !(f in tree))
  if (miss.length) fail(`[${label}] missing dmcc files: ${miss.slice(0, 8).join(', ')}`)
  // byte parity on files dmcc itself is deterministic about
  const bad = detContent.filter((f) => f in tree && !tree[f].equals(refA[f]))
  if (bad.length) fail(`[${label}] REAL divergence on ${bad.length} byte-deterministic file(s): ${bad.slice(0, 8).join(', ')}`)
  // assets: same content, just renamed → compare hash multiset
  const oursNondet = Object.keys(tree).filter((f) => !detName.includes(f))
  if (!eqMultiset(multiset(oursNondet.map((f) => sha(tree[f]))), refAssetHashes)) {
    fail(`[${label}] asset content multiset differs from dmcc (renamed is fine, corrupted is not)`)
  }
  // sourcemap parity with dmcc
  const js = (tree['main/logic.js'] || Buffer.alloc(0)).toString('utf8')
  if (!/\/\/# sourceMappingURL=logic\.js\.map\s*$/.test(js)) fail(`[${label}] logic.js missing trailing sourceMappingURL`)
  if (!tree['main/logic.js.map']) { fail(`[${label}] logic.js.map missing`); return }
  let map
  try { map = JSON.parse(tree['main/logic.js.map'].toString('utf8')) } catch (e) { fail(`[${label}] logic.js.map invalid JSON: ${e.message}`); return }
  const s = (map.sources || []).slice().sort()
  const rs = (refMap.sources || []).slice().sort()
  if (s.join('|') !== rs.join('|')) fail(`[${label}] logic.js.map sources differ from dmcc\n   ours: ${s.slice(0, 4).join(', ')}\n   dmcc: ${rs.slice(0, 4).join(', ')}`)
  if (!(Array.isArray(map.sourcesContent) && map.sourcesContent.some((c) => c && c.length))) fail(`[${label}] logic.js.map has no sourcesContent`)
  if (!failed) console.log(`[${label}] ✅ dmcc-equivalent (count+bytes+assets+sourcemap sources match dmcc)`)
}

// --- ours: pool, twice (warm reuse) ---------------------------------------
console.log('[ours] resident pool build ×2 (warm)')
const pool = createNodeCompilerPool()
const appInfo1 = await pool.build(dir('ours1'), APP, true, { sourcemap: true })
const appInfo2 = await pool.build(dir('ours2'), APP, true, { sourcemap: true })
await pool.dispose()

// The whole return value must match dmcc's, `path` included — dmcc's mainPages[1]
// read happens AFTER its style task unshifted `app` into the shared array, i.e. it
// is the original first page (the pool reads mainPages[0] of its unmutated array).
for (const key of ['appId', 'name', 'path']) {
  if (appInfo1[key] !== appInfoRefA[key]) fail(`appInfo.${key} mismatch: pool ${JSON.stringify(appInfo1[key])} vs dmcc ${JSON.stringify(appInfoRefA[key])}`)
}
if (appInfo1.appId !== appInfo2.appId) fail('appId not stable across warm rebuilds')
if (appInfo1.path !== appInfo2.path) fail('path not stable across warm rebuilds')

checkAgainstDmcc(readTree(path.join(dir('ours1'), appInfo1.appId)), 'cold')
checkAgainstDmcc(readTree(path.join(dir('ours2'), appInfo2.appId)), 'warm')

console.log(`[sourcemap] logic.js.map: ${refMap.sources.length} sources, sourcesContent present, matches dmcc ✅`)

// --- failure contract: the default drop-in build() must REJECT a broken compile ------------------
// (never resolve undefined and let the caller mistake a failed compile for success), and the pool
// must expose a pure helper that turns a missing-oxc-native-binding message into an actionable
// packaging hint (checked as a string mapping only — a real environment can't be made to lack the
// binding on demand).
console.log("[fail] broken fixture: default build() must reject, not resolve undefined")
function writeBrokenFixture(root) {
  const write = (rel, content) => {
    const target = path.join(root, rel)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, content)
  }
  write('project.config.json', JSON.stringify({ appid: 'fixture_app_broken', projectname: 'fixture-broken' }))
  write('app.json', JSON.stringify({ pages: ['pages/index/index'] }))
  write('app.js', 'App({})\n')
  write('app.wxss', 'page { font-size: 14px; }\n')
  write('pages/index/index.json', '{}\n')
  // Unbalanced brace + bad tokens — same corruption shape used by devkit's
  // open-project-compile-log fixture, chosen because it fails the logic stage
  // rather than being silently absorbed by esbuild's error-tolerant fallback.
  write('pages/index/index.js', 'Page({ data: { msg: "hi" } })\nconst broken = {{{ ;;; <<<\n')
  write('pages/index/index.wxml', '<view>{{msg}}</view>\n')
  write('pages/index/index.wxss', '.x { color: red; }\n')
}
const brokenRoot = dir('broken-fixture')
mkdirSync(brokenRoot, { recursive: true })
writeBrokenFixture(brokenRoot)

if (typeof defaultBuild !== 'function') {
  fail('pool.node.js must have a default export `build(outputDir, workPath, useAppIdDir?, options?)` — default export is missing/not a function')
}
else {
  let brokenResolvedValue
  let brokenRejectedError
  try {
    brokenResolvedValue = await defaultBuild(dir('broken-out'), brokenRoot, true, {})
  }
  catch (e) {
    brokenRejectedError = e
  }
  if (brokenRejectedError === undefined) {
    fail(`default build() must REJECT on a broken compile — instead it resolved to ${JSON.stringify(brokenResolvedValue)} (a swallowed error looks like success to every caller)`)
  }
  else if (!(brokenRejectedError instanceof Error) || !brokenRejectedError.message) {
    fail(`default build() rejected but without a usable Error message: ${brokenRejectedError}`)
  }
  else if (!/stage "logic" failed/.test(brokenRejectedError.message)) {
    fail(`default build() rejection message must name the failing stage, got: ${brokenRejectedError.message.split('\n')[0]}`)
  }
  else if (!/Transform failed/.test(brokenRejectedError.message)) {
    fail(`default build() rejection message must carry the underlying compile reason (esbuild transform failure), got: ${brokenRejectedError.message.split('\n')[0]}`)
  }
  else {
    console.log(`[fail] ✅ default build() rejected with: ${brokenRejectedError.message.split('\n')[0]}`)
  }
}

// --- oxcNativeBindingHint: pure message -> actionable-packaging-hint mapper -----------------------
if (typeof oxcNativeBindingHint !== 'function') {
  fail('pool.node.js must export a named `oxcNativeBindingHint(message)` helper — export is missing')
}
else {
  const hint = oxcNativeBindingHint('Cannot find native binding. It means oxc-parser was not installed correctly for this platform.')
  if (typeof hint !== 'string' || !hint.includes('@oxc-parser/binding-') || !hint.includes('wasm32-wasi')) {
    fail(`oxcNativeBindingHint must mention both the native platform binding package (@oxc-parser/binding-*) and the wasm32-wasi fallback, got: ${JSON.stringify(hint)}`)
  }
  else {
    console.log('[fail] ✅ oxcNativeBindingHint surfaces a packaging fix for a missing native binding')
  }
  const noHint = oxcNativeBindingHint('some unrelated compile error')
  if (noHint !== null) {
    fail(`oxcNativeBindingHint must return null for a message that is not the native-binding failure, got: ${JSON.stringify(noHint)}`)
  }
}

// The default export is a lazy module-level singleton pool (resident worker threads) — the
// broken-fixture build above spun it up, so the process cannot exit cleanly without disposing it.
if (typeof disposeDefaultPool !== 'function') {
  fail('pool.node.js must export `disposeDefaultPool()` to tear down the lazy default-export singleton pool')
}
else {
  await disposeDefaultPool()
}

console.log(failed ? '\n❌ FAIL' : '\n✅ PASS: resident Node pool is dmcc-equivalent (incl. sourcemap) on cold+warm builds, and rejects broken compiles')
process.exit(failed ? 1 : 0)
