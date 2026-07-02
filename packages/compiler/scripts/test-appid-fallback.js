// Guards that compileMiniApp always returns a usable appId, even when the
// project does not include a project.config.json with an explicit appid field.
// A missing/undefined appId would silently corrupt downstream resource paths
// (container ?appId= query string, file path prefixes) with no error thrown.

import assert from 'node:assert/strict'
import { Volume, createFsFromVolume } from 'memfs'
import { compileMiniApp } from '../dist/compile-core.node.js'

// web-compiler carries no fs; the caller injects one. memfs stands in as the
// downstream fs here — seed a files map at workPath and hand over its fs.
const WP = '/work'
const fsOf = (files) => createFsFromVolume(Volume.fromJSON(files, WP))

// Minimal valid mini-program with no project.config.json.
const MINIMAL_FILES = {
  'app.js': 'App({})',
  'app.json': JSON.stringify({ pages: ['pages/index'] }),
  'pages/index.js': 'Page({ data: {} })',
  'pages/index.wxml': '<view>hello</view>',
}

// A project that carries an explicit appid in project.config.json.
const EXPLICIT_APPID = 'wxTESTappid123456'
const FILES_WITH_CONFIG = {
  ...MINIMAL_FILES,
  'project.config.json': JSON.stringify({
    appid: EXPLICIT_APPID,
    compileType: 'miniprogram',
    setting: { es6: true },
  }),
}

let passed = 0
let failed = 0

function ok(label, fn) {
  try {
    fn()
    console.log(`  ✅ PASS  ${label}`)
    passed++
  } catch (err) {
    console.error(`  ❌ FAIL  ${label}`)
    console.error(`         ${err.message}`)
    failed++
  }
}

// ---------------------------------------------------------------------------
// Group 1: No project.config.json — appId must be a non-empty string and must
// not appear as the literal text "undefined" in any output file path.
// ---------------------------------------------------------------------------
console.log('\nGroup 1: no project.config.json → appId must be a usable non-empty string')

const r1 = await compileMiniApp({ fs: fsOf(MINIMAL_FILES), workPath: WP })
console.log(`  actual appId = ${JSON.stringify(r1.appId)}`)

ok('appId is a string', () => {
  assert.equal(typeof r1.appId, 'string', `expected string, got ${typeof r1.appId}`)
})

ok('appId is non-empty', () => {
  assert.ok(r1.appId.length > 0, 'appId must not be an empty string')
})

ok('appId is not the literal "undefined"', () => {
  assert.notEqual(r1.appId, 'undefined', 'appId must not be the string "undefined"')
})

const keysWithUndefined = Object.keys(r1.files).filter((k) => k.includes('undefined'))
ok('output file paths contain no "undefined" segment', () => {
  assert.deepEqual(
    keysWithUndefined,
    [],
    `These output paths contain "undefined": ${JSON.stringify(keysWithUndefined)}`,
  )
})

// ---------------------------------------------------------------------------
// Group 2: Determinism — same input twice must yield identical appId values.
// ---------------------------------------------------------------------------
console.log('\nGroup 2: determinism — same input produces the same appId on repeated calls')

const r2a = await compileMiniApp({ fs: fsOf(MINIMAL_FILES), workPath: WP })
const r2b = await compileMiniApp({ fs: fsOf(MINIMAL_FILES), workPath: WP })
console.log(`  call-1 appId = ${JSON.stringify(r2a.appId)}`)
console.log(`  call-2 appId = ${JSON.stringify(r2b.appId)}`)

ok('appId is stable across two calls with the same input', () => {
  assert.equal(r2a.appId, r2b.appId, 'appId must be deterministic for the same input')
})

// ---------------------------------------------------------------------------
// Group 3: Explicit appid — project.config.json.appid takes precedence and
// must be forwarded verbatim. Existing behaviour must not regress.
// ---------------------------------------------------------------------------
console.log('\nGroup 3: explicit appid in project.config.json is returned verbatim')

const r3 = await compileMiniApp({ fs: fsOf(FILES_WITH_CONFIG), workPath: WP })
console.log(`  actual appId = ${JSON.stringify(r3.appId)}`)

ok(`appId equals the declared "${EXPLICIT_APPID}"`, () => {
  assert.equal(r3.appId, EXPLICIT_APPID)
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${'─'.repeat(60)}`)
console.log(`Results: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  process.exit(1)
}
console.log('All assertions passed.')
