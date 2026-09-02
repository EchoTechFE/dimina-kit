// Every pool rejection carries `err.code`, and a code the WORKER chose survives the trip
// out to the caller. That second half is what this test protects: a stage worker is the
// only place that can tell "the host's wasm toolchain didn't load" apart from "this
// project doesn't compile" — both arrive at the pool as the same { type:'error' } reply.
// If the pool overwrote the worker's code with the generic compiler-stage-error, a host
// would be back to matching error-message text to decide whether retrying or falling back
// to another compile path is worth it.
//
// Drives the REAL src/pool.js against fake Worker-shaped objects (no build, no browser),
// the same technique as scripts/test-pool-worker-hardening.js.
import {
  COMPILER_ERROR_CODES,
  INFRASTRUCTURE_ERROR_CODES,
  WORKER_DEATH_CODES,
  isCompilerErrorCode,
  isInfrastructureError,
} from '../src/error-codes.js'
import {
  COMPILER_ERROR_CODES as POOL_CODES,
  createCompilerPool,
  isInfrastructureError as poolIsInfrastructureError,
} from '../src/pool.js'
// The Node pool's message→code classification lives in its own module precisely so it can
// be driven here: importing pool-node.js would pull in worker_threads and the compiler
// core, which is why this rule used to go untested until a real Node build ran.
import { errorCodeForMessage, tagFailure } from '../src/failure-hints.js'

let failed = false
const chk = (cond, msg) => { if (!cond) { failed = true; console.error(`❌ ${msg}`) } else console.log(`✅ ${msg}`) }

const STAGES = ['logic', 'view', 'style']
const FILES = { 'app.json': '{"pages":["pages/index/index"]}' }

// A fake Worker that answers every message normally except the one message `failOn`
// names, which it answers with a worker-side error reply carrying `code` (undefined for
// a plain compile error). `spawns` counts constructions so a test can prove the pool did
// not retry.
function fakeWorkerFactory({ failOn, code, message = 'boom' }) {
  const spawns = { count: 0 }
  const createWorker = () => {
    spawns.count += 1
    const w = {
      onmessage: null,
      onerror: null,
      onmessageerror: null,
      terminate() {},
      postMessage(m) {
        queueMicrotask(() => {
          let resp
          if (m.type === failOn) resp = { type: 'error', error: message, code }
          else if (m.type === 'warmup') resp = { type: 'ready', ms: 1 }
          else if (m.type === 'setup') {
            resp = {
              type: 'setup-done',
              bundle: { appId: 'app1', name: 'demo', pages: [], storeInfo: {}, targetPath: '/work/dist' },
              scaffold: { 'app-config.json': '{}' },
            }
          } else if (m.type === 'compile-subset') {
            resp = { type: 'done', result: { appId: 'app1', name: 'demo', files: { [`${m.stages[0]}.out`]: 'x' } } }
          }
          if (w.onmessage) w.onmessage({ data: resp })
        })
      },
    }
    return w
  }
  return { createWorker, spawns }
}

async function compileAgainst(config) {
  const { createWorker, spawns } = fakeWorkerFactory(config)
  const pool = createCompilerPool({
    createWorker,
    toolchainSetupURL: 'data:text/javascript,export default {}',
    stages: STAGES,
  })
  try {
    const files = await pool.compile({ files: FILES })
    return { ok: true, files, spawns }
  } catch (err) {
    return { ok: false, err, spawns }
  } finally {
    await pool.dispose()
  }
}

async function main() {
  // --- the constants themselves -------------------------------------------------
  {
    const values = Object.values(COMPILER_ERROR_CODES)
    chk(new Set(values).size === values.length, `every code is a distinct string (${values.length} codes)`)
    chk(Object.isFrozen(COMPILER_ERROR_CODES), 'COMPILER_ERROR_CODES is frozen — a host cannot mutate the shared table')
    chk(!INFRASTRUCTURE_ERROR_CODES.has(COMPILER_ERROR_CODES.stageError),
      'a compile error is NOT infrastructure — retrying a broken project only hides the diagnostic')
    chk([...WORKER_DEATH_CODES].every((c) => INFRASTRUCTURE_ERROR_CODES.has(c)),
      'every worker-death code is also an infrastructure code')
    chk(isInfrastructureError({ code: COMPILER_ERROR_CODES.toolchainSetupFailed })
      && isInfrastructureError({ code: COMPILER_ERROR_CODES.toolchainDead }),
    'isInfrastructureError() accepts a failed toolchain import and a dead toolchain service')
    chk(!isInfrastructureError({ code: COMPILER_ERROR_CODES.stageError })
      && !isInfrastructureError(null) && !isInfrastructureError('compiler-worker-dead') && !isInfrastructureError(new Error('x')),
    'isInfrastructureError() rejects compile errors, non-objects and uncoded errors')
    chk(POOL_CODES === COMPILER_ERROR_CODES && poolIsInfrastructureError === isInfrastructureError,
      'the pool re-exports the same table and predicate, so a host never copies the strings')
    chk(isCompilerErrorCode(COMPILER_ERROR_CODES.workerDead)
      && !isCompilerErrorCode('ENOENT') && !isCompilerErrorCode(undefined),
    'isCompilerErrorCode() accepts a published code and rejects anything else')
  }

  // --- the exported sets are read-only, not merely frozen ------------------------
  // Object.freeze() leaves a Set fully mutable, and these two drive the pool's OWN
  // retry decisions: one .add() in host code would silently change when this package
  // retries a build.
  {
    for (const [name, set] of [['INFRASTRUCTURE_ERROR_CODES', INFRASTRUCTURE_ERROR_CODES], ['WORKER_DEATH_CODES', WORKER_DEATH_CODES]]) {
      for (const method of ['add', 'delete', 'clear']) {
        let threw = false
        try { set[method]('compiler-stage-error') } catch { threw = true }
        chk(threw, `${name}.${method}() throws instead of changing the pool's retry policy`)
      }
      chk(set.has(COMPILER_ERROR_CODES.workerDead) && set.size > 0, `${name} is still readable (has + size)`)
    }
  }

  // --- Node message → code, the classification the disk pool applies -------------
  {
    const oxc = 'Error: Cannot find native binding. npm has a bug related to optional dependencies'
    const asar = 'Error: spawn /Applications/Demo.app/Contents/Resources/app.asar/node_modules/@esbuild/darwin-arm64/bin/esbuild ENOENT'
    chk(errorCodeForMessage(oxc) === COMPILER_ERROR_CODES.toolchainUnavailable,
      `a missing oxc-parser binding is a packaging failure, not the project's fault (got ${errorCodeForMessage(oxc)})`)
    chk(errorCodeForMessage(asar) === COMPILER_ERROR_CODES.toolchainUnavailable,
      `esbuild's binary unspawnable inside app.asar is a packaging failure too (got ${errorCodeForMessage(asar)})`)
    chk(isInfrastructureError({ code: errorCodeForMessage(oxc) }),
      'so the host may fall back to another compile path instead of showing the user a compile error')
    chk(errorCodeForMessage('The service was stopped') === COMPILER_ERROR_CODES.toolchainDead
      && errorCodeForMessage('The service is no longer running') === COMPILER_ERROR_CODES.toolchainDead,
    "a dead esbuild service is compiler-toolchain-dead — that realm's worker has to be recycled")
    chk(errorCodeForMessage('SyntaxError: Unexpected token in app.json') === COMPILER_ERROR_CODES.stageError,
      'an ordinary compile failure stays compiler-stage-error')

    const tagged = tagFailure(new Error(oxc), 'logic')
    chk(tagged.code === COMPILER_ERROR_CODES.toolchainUnavailable && tagged.stage === 'logic',
      'tagFailure() records both the code the message earned and the stage it came from')
    chk(/electron-builder|binding-wasm32-wasi/.test(tagged.message),
      'and appends the packaging hint, because the raw oxc message says nothing about packaging')
    const preset = tagFailure(Object.assign(new Error(oxc), { code: COMPILER_ERROR_CODES.stageError, stage: 'view' }), 'logic')
    chk(preset.code === COMPILER_ERROR_CODES.stageError && preset.stage === 'view' && preset.message === oxc,
      'a code set closer to the failure wins — tagFailure() never overwrites one')
    chk(tagFailure('not an error object').code === COMPILER_ERROR_CODES.stageError,
      'a thrown non-Error still comes out as a coded Error')
    chk(tagFailure(new Error('EACCES: permission denied'), null, COMPILER_ERROR_CODES.outputWriteFailed).code
      === COMPILER_ERROR_CODES.outputWriteFailed,
    'a caller that already knows the category (copying to outputDir failed) passes it in')
  }

  // --- a call the host got wrong is not the project's fault ----------------------
  {
    const { createWorker } = fakeWorkerFactory({ failOn: null })
    const pool = createCompilerPool({ createWorker, toolchainSetupURL: 'data:text/javascript,export default {}', stages: STAGES })
    const err = await pool.compile({ files: {} }).then(() => null, (e) => e)
    await pool.dispose()
    chk(!!err && err.code === COMPILER_ERROR_CODES.invalidInput,
      `compile() with an empty files map rejects with compiler-invalid-input (got ${err && err.code})`)
    chk(!!err && !isInfrastructureError(err), 'and is not retryable — a fresh worker cannot fix the caller')
  }

  // --- a worker-classified failure keeps its own code all the way out ------------
  {
    const r = await compileAgainst({
      failOn: 'warmup',
      code: COMPILER_ERROR_CODES.toolchainSetupFailed,
      message: '[compiler] toolchain setup failed importing https://host/toolchain.js: Failed to fetch',
    })
    chk(!r.ok && r.err.code === COMPILER_ERROR_CODES.toolchainSetupFailed,
      `a warmup that fails to import the toolchain rejects with compiler-toolchain-setup-failed (got ${r.ok ? 'resolved' : r.err.code})`)
    chk(!r.ok && isInfrastructureError(r.err),
      'that rejection is classified as infrastructure, so a host can fall back to another compile path')
    chk(!r.ok && String(r.err.message).includes('Failed to fetch'),
      `the worker's own message survives (got ${r.ok ? '' : JSON.stringify(String(r.err.message).slice(0, 80))})`)
    chk(r.spawns.count === STAGES.length,
      `an error REPLY is not worker death: the pool does not respawn or retry (spawned ${r.spawns.count}, expected ${STAGES.length})`)
  }

  // --- an uncoded worker error is the project's fault ----------------------------
  {
    const r = await compileAgainst({ failOn: 'setup', message: 'SyntaxError: Unexpected token in app.json' })
    chk(!r.ok && r.err.code === COMPILER_ERROR_CODES.stageError,
      `a worker error reply with no code defaults to compiler-stage-error (got ${r.ok ? 'resolved' : r.err.code})`)
    chk(!r.ok && !isInfrastructureError(r.err), 'a compile error is never retried on fresh machinery')
    chk(!r.ok && r.err.stage === STAGES[0], `the rejection still names the stage that reported it (got ${r.ok ? '' : r.err.stage})`)
  }

  // --- a code the worker made up does not reach the host -------------------------
  // A stage worker can fail on something whose error already carries an unrelated `code`
  // (memfs throws ENOENT, node throws EACCES). Passing that straight through would give
  // hosts a value their branches do not cover and their `catch` cannot classify.
  {
    const r = await compileAgainst({ failOn: 'setup', code: 'ENOENT', message: "ENOENT: no such file, open '/work/app.json'" })
    chk(!r.ok && r.err.code === COMPILER_ERROR_CODES.stageError,
      `a worker reply carrying a non-published code (ENOENT) is normalized to compiler-stage-error (got ${r.ok ? 'resolved' : r.err.code})`)
    chk(!r.ok && String(r.err.message).includes('ENOENT'),
      'the original message still reaches the user — only the code is normalized')
  }

  // --- the same propagation on the compile step, not just warmup -----------------
  {
    const r = await compileAgainst({
      failOn: 'compile-subset',
      code: COMPILER_ERROR_CODES.toolchainSetupFailed,
      message: '[compiler] toolchain setup failed importing https://host/toolchain.js: 404',
    })
    chk(!r.ok && r.err.code === COMPILER_ERROR_CODES.toolchainSetupFailed,
      `a toolchain import that fails at compile-subset time keeps its code too (got ${r.ok ? 'resolved' : r.err.code})`)
  }

  // --- a disposed pool says so, rather than looking like a worker fault ----------
  {
    const { createWorker } = fakeWorkerFactory({ failOn: null })
    const pool = createCompilerPool({ createWorker, toolchainSetupURL: 'data:text/javascript,export default {}', stages: STAGES })
    await pool.dispose()
    const err = await pool.compile({ files: FILES }).then(() => null, (e) => e)
    chk(!!err && err.code === COMPILER_ERROR_CODES.poolDisposed,
      `compile() after dispose() rejects with compiler-pool-disposed (got ${err && err.code})`)
  }

  console.log(failed ? '\n❌ error-code assertions failed.' : '\n✅ pool rejections carry stable codes, and a worker-classified failure keeps its own.')
  process.exit(failed ? 1 : 0)
}

await main()
