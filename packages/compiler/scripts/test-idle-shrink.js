// Idle-shrink contract for the resident Node worker_threads pool
// (dist/pool.node.js): once the build queue drains, if idleShrinkMs elapses
// with no new build activity, the pool terminates all stage worker threads to
// release memory — but the pool object itself stays usable, and a later
// build() transparently revives the workers and still publishes intact output.
//
// Conditions 1/2/6 share one pool instance (build → shrink → revive-build →
// shrink again → dispose) to keep the total number of real dmcc builds in this
// file bounded; each condition's own assertion is still checked independently.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const APP = process.env.TEST_PROJECT
  || fileURLToPath(new URL('../../../dimina/fe/example/base', import.meta.url))
const TMP = fileURLToPath(new URL('../.tmp-idle-shrink/', import.meta.url))
fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(TMP, { recursive: true })
const dir = (n) => path.join(TMP, n)

let failed = false
const chk = (cond, msg) => { if (!cond) { failed = true; console.error(`❌ ${msg}`) } else console.log(`✅ ${msg}`) }
const withTimeout = (p, ms, label) => Promise.race([
  p,
  new Promise((_, rej) => setTimeout(() => rej(new Error(`TIMEOUT: ${label} did not settle in ${ms}ms`)), ms).unref()),
])
const allDead = (pool) => pool._slots.every((x) => x.slot.isDead())
const treeOk = (d, i) => fs.existsSync(path.join(d, i.appId, 'main', 'logic.js')) && fs.existsSync(path.join(d, i.appId, 'main', 'app.css'))

// Polls `fn` (a plain boolean-returning check) until it's true or the deadline
// passes; returns the last observed value either way (never throws/hangs).
async function pollUntil(fn, deadlineMs, intervalMs = 150) {
  const start = Date.now()
  let last = fn()
  while (!last && Date.now() - start < deadlineMs) {
    await new Promise((r) => setTimeout(r, intervalMs))
    last = fn()
  }
  return last
}

const { createNodeCompilerPool } = await import('../dist/pool.node.js')
const pools = []
function makePool(opts) { const p = createNodeCompilerPool(opts); pools.push(p); return p }

// --- conditions 1, 2, 6: shrink after idle / transparent revive / dispose after shrink --
{
  const pool = makePool({ idleShrinkMs: 300 })
  const info1 = await withTimeout(pool.build(dir('a1'), APP, true, {}), 60000, 'shrink baseline build')
  chk(!!info1.appId && treeOk(dir('a1'), info1), 'baseline build for idle-shrink completes and publishes intact output')

  const shrunk = await pollUntil(() => allDead(pool), 3000)
  chk(shrunk === true,
    `all stage workers report isDead()===true within 3s of the last build going idle (idleShrinkMs=300) — states: ${JSON.stringify(pool._slots.map((x) => x.slot.isDead()))}`)

  const info2 = await withTimeout(pool.build(dir('a2'), APP, true, {}), 60000, 'build after shrink')
  chk(!!info2.appId && treeOk(dir('a2'), info2), 'build() after a shrink transparently revives the workers and publishes intact output')
  chk(pool._slots.every((x) => !x.slot.isDead()), 'after the revive build, every slot reports isDead()===false')

  await pollUntil(() => allDead(pool), 3000) // let it shrink again (or not) before disposing
  await withTimeout(pool.dispose(), 10000, 'dispose after shrink')
  const after = await pool.build(dir('a3'), APP, true, {}).then(() => 'resolved', (e) => e)
  chk(after !== 'resolved' && after.code === 'compiler-pool-disposed',
    `build() after dispose() (which followed a shrink) rejects with code compiler-pool-disposed (got ${after === 'resolved' ? 'resolved' : after.code})`)
}

// --- condition 3: repeated build activity cancels a pending shrink -------------------
{
  const pool = makePool({ idleShrinkMs: 600 })
  await withTimeout(pool.build(dir('b1'), APP, true, {}), 60000, 'activity build 1')
  await new Promise((r) => setTimeout(r, 250))
  await withTimeout(pool.build(dir('b2'), APP, true, {}), 60000, 'activity build 2')
  await new Promise((r) => setTimeout(r, 250))
  await withTimeout(pool.build(dir('b3'), APP, true, {}), 60000, 'activity build 3')
  chk(pool._slots.every((x) => !x.slot.isDead()),
    'repeated build activity spaced well under idleShrinkMs keeps every slot alive — no shrink fires mid-activity')
  await pool.dispose()
}

// --- condition 4: idleShrinkMs only starts counting AFTER build() settles -----------
{
  const pool = makePool({ idleShrinkMs: 50 })
  const info = await withTimeout(pool.build(dir('c1'), APP, true, {}), 60000, 'build with tiny idleShrinkMs')
  chk(!!info.appId && treeOk(dir('c1'), info),
    'a build that runs far longer than idleShrinkMs still completes and publishes intact output — the shrink clock only starts once the build queue is idle')
  await pool.dispose()
}

// --- condition 5: idleShrinkMs falsy values disable shrinking entirely ---------------
{
  const pool = makePool({ idleShrinkMs: 0 })
  await withTimeout(pool.build(dir('d1'), APP, true, {}), 60000, 'disabled-shrink build')
  await new Promise((r) => setTimeout(r, 500))
  chk(pool._slots.every((x) => !x.slot.isDead()), 'idleShrinkMs:0 keeps every stage worker alive indefinitely (shrink switched off)')
  await pool.dispose()
}

// --- condition 7: shrink releases every handle — a host process exits on its own ----
{
  const childScript = path.join(TMP, 'idle-shrink-child.mjs')
  const poolNodeURL = fileURLToPath(new URL('../dist/pool.node.js', import.meta.url))
  fs.writeFileSync(childScript, `
const { createNodeCompilerPool } = await import(${JSON.stringify(poolNodeURL)})
const pool = createNodeCompilerPool({ idleShrinkMs: 200 })
await pool.build(${JSON.stringify(dir('e1'))}, ${JSON.stringify(APP)}, true, {})
// Deliberately no dispose() and no other open handles: a healthy shrink must
// let this process exit on its own once its worker threads are torn down.
`)
  const child = spawn(process.execPath, [childScript], { stdio: 'inherit' })
  const exitOutcome = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({ timedOut: true })
      try { child.kill('SIGKILL') } catch { /* already gone */ }
    }, 15000)
    child.on('exit', (code) => { clearTimeout(timer); resolve({ timedOut: false, code }) })
  })
  chk(exitOutcome.timedOut === false && exitOutcome.code === 0,
    `a host process that builds once with idleShrinkMs and never calls dispose() exits on its own within 15s once the shrink tears down its worker threads (got ${JSON.stringify(exitOutcome)})`)
}

// --- teardown -------------------------------------------------------------------------
await Promise.all(pools.map((p) => p.dispose().catch(() => {})))
fs.rmSync(TMP, { recursive: true, force: true })
console.log(failed ? '\n❌ FAIL' : '\n✅ PASS: idle shrink, transparent revive, activity cancels shrink, dispose guard, and clean process exit all hold')
process.exit(failed ? 1 : 0)
