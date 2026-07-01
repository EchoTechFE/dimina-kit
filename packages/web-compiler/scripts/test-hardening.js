// Regression tests for the adversarial-review hardening:
//  #1 concurrent compiles in one realm must not cross fs / env singletons
//  #2 ensureAppIdFs must not clobber malformed JSON, must reject bad appid
//  #5 the fs contract is validated up-front with a clear error
// memfs stands in as the downstream fs.
import assert from 'node:assert/strict'
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

let pass = 0
let fail = 0
const check = async (label, fn) => {
  try { await fn(); console.log(`  ✅ ${label}`); pass++ }
  catch (e) { console.error(`  ❌ ${label}\n       ${e.message}`); fail++ }
}

// #5 — a partial fs is rejected up front, naming the missing method.
await check('missing fs method throws up front, naming it', async () => {
  const partial = { readFileSync() {}, readdirSync() {} } // lacks writeFileSync etc.
  await assert.rejects(
    () => compileMiniApp({ fs: partial, workPath: WP }),
    /missing required method\(s\):.*writeFileSync/,
  )
})

// #2a — malformed project.config.json is NOT overwritten; a clear error is thrown.
await check('malformed project.config.json throws and is preserved', async () => {
  const vol = volOf({ ...BASE, 'project.config.json': '{bad json' })
  await assert.rejects(
    () => compileMiniApp({ fs: createFsFromVolume(vol), workPath: WP }),
    /not valid JSON/,
  )
  assert.equal(vol.readFileSync(`${WP}/project.config.json`, 'utf8'), '{bad json', 'original file must be untouched')
})

// #2b — a non-string appid is rejected (would otherwise corrupt output paths).
await check('non-string appid throws', async () => {
  const files = { ...BASE, 'project.config.json': JSON.stringify({ appid: { x: 1 } }) }
  await assert.rejects(
    () => compileMiniApp({ fs: fsOf(files), workPath: WP }),
    /"appid" must be a non-empty string/,
  )
})

// #1 — two compiles fired concurrently must keep distinct appIds (serialization
// prevents the module-level fs backend / env singletons from crossing).
await check('concurrent compiles keep distinct appIds', async () => {
  const A = { ...BASE, 'project.config.json': JSON.stringify({ appid: 'wxAAAAAAAAAAAAAAAA' }) }
  const B = { ...BASE, 'project.config.json': JSON.stringify({ appid: 'wxBBBBBBBBBBBBBBBB' }) }
  const [ra, rb] = await Promise.all([
    compileMiniApp({ fs: fsOf(A), workPath: WP }),
    compileMiniApp({ fs: fsOf(B), workPath: WP }),
  ])
  assert.equal(ra.appId, 'wxAAAAAAAAAAAAAAAA', 'compile A got the wrong appId (state crossed)')
  assert.equal(rb.appId, 'wxBBBBBBBBBBBBBBBB', 'compile B got the wrong appId (state crossed)')
  assert.ok(Object.keys(ra.files).length > 0 && Object.keys(rb.files).length > 0, 'both must produce files')
})

// sanity — the happy path still works after all the guards.
await check('happy path still compiles', async () => {
  const r = await compileMiniApp({ fs: fsOf(BASE), workPath: WP })
  assert.equal(typeof r.appId, 'string')
  assert.ok(r.appId.length > 0)
})

console.log(`\n${'─'.repeat(56)}\nResults: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
console.log('All hardening assertions passed.')
