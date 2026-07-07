// Regression coverage for the resident Node disk pool's handling of a DEAD esbuild
// toolchain service — the Windows-packaged-app crash pattern: esbuild's JS lib spawns
// a long-lived binary child process (the "service"), and in a packaged Electron app
// that spawn can fail (e.g. the binary sits inside app.asar, which fs.existsSync()
// sees but child_process.spawn() cannot exec). Once that service is dead inside a
// warm worker realm, EVERY later esbuild call in that same realm fails with
// "The service is no longer running: write EPIPE" — a message shape that looks
// nothing like the real cause. Today the pool classifies this as
// `code: 'compiler-stage-error'` ("deterministic, never retried") and keeps the
// broken worker, so the pool never recovers even after the environment is healed.
//
// Fault injection needs no source changes: esbuild's node lib honors
// ESBUILD_BINARY_PATH, and each worker_threads realm captures a COPY of
// process.env at spawn. Pointing that var (before the pool spawns its workers) at
// a real, executable file whose shebang interpreter does not exist reproduces the
// exact "fs.existsSync() true, spawn() ENOENT" split a binary trapped inside
// app.asar produces — child_process.spawn() reports ENOENT because the kernel's
// own shebang-interpreter lookup fails, not because the file is missing.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP = process.env.APP_DIR
  || fileURLToPath(new URL('../../../dimina/fe/example/base', import.meta.url))
const TMP = fileURLToPath(new URL('../.tmp-pool-toolchain-death/', import.meta.url))
fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(TMP, { recursive: true })
const dir = (n) => path.join(TMP, n)

const FAKE_ESBUILD = path.join(TMP, 'fake-esbuild-service')
fs.writeFileSync(FAKE_ESBUILD, '#!/nonexistent/esbuild-interpreter\necho unreachable\n')
fs.chmodSync(FAKE_ESBUILD, 0o755)

let failed = false
const chk = (cond, msg) => { if (!cond) { failed = true; console.error(`❌ ${msg}`) } else console.log(`✅ ${msg}`) }
const withTimeout = (p, ms, label) => Promise.race([
  p,
  new Promise((_, rej) => setTimeout(() => rej(new Error(`TIMEOUT: ${label} did not settle in ${ms}ms`)), ms).unref()),
])
const settle = (p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }))
const treeOk = (d, i) => fs.existsSync(path.join(d, i.appId, 'main', 'logic.js'))

// Property access (not a named import) so a dist build that has not yet added
// esbuildAsarSpawnHint fails this script's own assertion instead of a module-link
// SyntaxError that would abort before any other scenario runs.
const poolModule = await import('../dist/pool.node.js')
const { createNodeCompilerPool } = poolModule
const esbuildAsarSpawnHint = poolModule.esbuildAsarSpawnHint

// --- classification + recycle ------------------------------------------------------
// A dead esbuild service must be coded distinctly from a real compile error, and the
// worker(s) that hit it must be recycled so the NEXT build — once the environment is
// healed — runs on a fresh realm instead of replaying the same dead service forever.
process.env.ESBUILD_BINARY_PATH = FAKE_ESBUILD
const pool = createNodeCompilerPool({ retryOnWorkerDeath: false })
// Read immediately after creation, before the pool's own eager ensureAlive() settles —
// the pristine pre-spawn baseline every later generation count is compared against.
const gensPristine = pool._slots.map((x) => x.slot.generation)

const first = await withTimeout(
  settle(pool.build(dir('a1'), APP, true, {})), 60000, 'first build against a dead esbuild service',
)
chk(!first.ok, 'first build against a dead esbuild service rejects')
const firstErr = first.ok ? null : first.e
chk(!!firstErr && firstErr.code === 'compiler-toolchain-dead',
  `dead-esbuild-service failure is coded 'compiler-toolchain-dead' (got ${firstErr && firstErr.code})`)
chk(!!firstErr && typeof firstErr.stage === 'string' && firstErr.stage.length > 0,
  `error carries .stage (got ${firstErr && firstErr.stage})`)
chk(!!firstErr && /^\[compiler\] stage "[^"]+" failed: .*The service (was stopped|is no longer running)/.test(firstErr.message || ''),
  `error message keeps the stage-shaped prefix around the dead-service cause: ${firstErr && firstErr.message}`)

// Heal the environment the way a real fix would (repackage / relaunch): only NEWLY
// spawned worker realms see this — the pool must actually recycle, not get lucky that
// the already-spawned realm somehow un-breaks itself.
delete process.env.ESBUILD_BINARY_PATH

const second = await withTimeout(
  settle(pool.build(dir('a2'), APP, true, {})), 60000, 'build after healing the toolchain env',
)
chk(second.ok && treeOk(dir('a2'), second.v),
  `build after healing the env succeeds via recycled workers, not a permanent write EPIPE: ${second.ok ? 'ok' : second.e && second.e.message}`)

const gensAfterHeal = pool._slots.map((x) => x.slot.generation)
chk(gensAfterHeal.some((g, i) => g - gensPristine[i] > 1),
  `pool recycled at least one worker slot between the dead-service failure and the next build (pristine ${gensPristine.join(',')} -> after-heal ${gensAfterHeal.join(',')})`)

await pool.dispose()

// --- transparent retry on a persistently broken toolchain --------------------------
// retryOnWorkerDeath defaults to true and already gives worker crashes one whole-build
// retry; a dead-toolchain failure must get the same treatment. With the environment
// STILL broken the retry cannot succeed either, so the build must still reject (no
// hang) — but by then the affected slot(s) should have been recycled on both the
// initial attempt and its retry.
process.env.ESBUILD_BINARY_PATH = FAKE_ESBUILD
const poolR = createNodeCompilerPool() // retryOnWorkerDeath defaults to true
const gensPristineR = poolR._slots.map((x) => x.slot.generation)

const retried = await withTimeout(
  settle(poolR.build(dir('r1'), APP, true, {})), 120000, 'build against a persistently dead esbuild service with retry enabled',
)
chk(!retried.ok, 'build against a persistently dead toolchain still rejects rather than hanging')
chk(!retried.ok && retried.e && retried.e.code === 'compiler-toolchain-dead',
  `the final rejection after the transparent retry is still coded 'compiler-toolchain-dead' (got ${retried.ok ? undefined : retried.e && retried.e.code})`)

const gensAfterRetry = poolR._slots.map((x) => x.slot.generation)
chk(gensAfterRetry.some((g, i) => g - gensPristineR[i] > 1),
  `a persistently dead toolchain is recycled on both the initial attempt and its retry (pristine ${gensPristineR.join(',')} -> after-retry ${gensAfterRetry.join(',')})`)

await poolR.dispose()
delete process.env.ESBUILD_BINARY_PATH

// --- pure helper: actionable asar-unpack hint for a dead esbuild service ------------
chk(typeof esbuildAsarSpawnHint === 'function', 'esbuildAsarSpawnHint is exported from the pool module')
if (typeof esbuildAsarSpawnHint === 'function') {
  const asarMsg = 'The service was stopped: spawn C:\\Users\\x\\AppData\\Local\\Programs\\myapp\\resources\\app.asar\\node_modules\\@esbuild\\win32-x64\\esbuild.exe ENOENT'
  const hint = esbuildAsarSpawnHint(asarMsg)
  chk(typeof hint === 'string' && /asarUnpack/.test(hint),
    `an asar-packaged esbuild ENOENT message gets an asarUnpack hint (got ${JSON.stringify(hint)})`)

  const syntaxMsg = 'Transform failed with 1 error:\nfile.js:1:1: ERROR: Unexpected "}"'
  chk(esbuildAsarSpawnHint(syntaxMsg) === null,
    `an unrelated esbuild syntax error gets no hint (got ${JSON.stringify(esbuildAsarSpawnHint(syntaxMsg))})`)

  const oxcMsg = 'Cannot find native binding. Napi module could not be resolved.'
  chk(esbuildAsarSpawnHint(oxcMsg) === null,
    `an oxc native-binding message (oxcNativeBindingHint's own territory) gets no hint here (got ${JSON.stringify(esbuildAsarSpawnHint(oxcMsg))})`)
} else {
  failed = true
  console.error('❌ skipped esbuildAsarSpawnHint behavior checks (not exported)')
}

fs.rmSync(TMP, { recursive: true, force: true })
console.log(failed ? '\n❌ FAIL' : '\n✅ PASS: dead-esbuild-service classification, recycle-on-failure, retry-still-rejects, asar hint')
process.exit(failed ? 1 : 0)
