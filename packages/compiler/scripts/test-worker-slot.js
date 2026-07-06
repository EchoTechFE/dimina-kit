// Contract tests for src/worker-slot.js — the shared "one live transport + FIFO
// request queue + inactivity watchdog" primitive that both the browser pool
// (src/pool.js) and the Node pool (src/pool-node.js) are meant to build on.
//
// Every scenario drives createWorkerSlot() against a fake transport built purely
// from the spawnTransport({ onMessage, onCrash }) => { postMessage, terminate }
// contract described in the task — no real Worker/worker_threads is involved, so
// this runs in plain Node with no build step.
import { EventEmitter } from 'node:events'
import { createWorkerSlot } from '../src/worker-slot.js'

let failed = false
const chk = (cond, msg) => { if (!cond) { failed = true; console.error(`❌ ${msg}`) } else console.log(`✅ ${msg}`) }

// Races p against a watchdog timeout; always settles (and clears the timer) once p
// settles, so a bare Promise.race([p, timeoutPromise]) does not leave the timeout
// branch permanently unsettled (Node's unsettled-top-level-await diagnostic flags that).
const withTimeout = (p, ms, label) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`TIMEOUT: ${label} did not settle in ${ms}ms`)), ms)
  p.then((v) => { clearTimeout(t); resolve(v) }, (e) => { clearTimeout(t); reject(e) })
})

// Peeks at whether `p` has settled within `ms` without consuming it for the caller's
// eventual real await — used to assert "still pending" for watchdog/dead-transport tests
// where a bare await would hang forever if the assertion under test were false.
const raceDelay = (p, ms) => Promise.race([
  p.then((value) => ({ settled: true, ok: true, value }), (error) => ({ settled: true, ok: false, error })),
  new Promise((resolve) => setTimeout(() => resolve({ settled: false }), ms)),
])

// A minimal spawnTransport factory: postMessage() just logs, and the onMessage/onCrash
// callbacks handed to spawnTransport() are exposed on `record.callbacks` so a test can
// simulate messages/crashes by calling them directly (deterministic, no scripted replies
// needed for FIFO/watchdog/stale-drop scenarios). terminate() is void unless
// `terminateDelayMs` is given, in which case it returns a Promise that resolves after
// that delay (mirrors worker_threads.Worker#terminate()'s Promise<exitCode> return).
function makeTransport(spec = {}) {
  const { terminateDelayMs, onTerminateResolved } = spec
  const record = { terminated: false, postMessageLog: [], callbacks: null }
  const spawnTransport = (callbacks) => {
    record.callbacks = callbacks
    return {
      postMessage(m) { record.postMessageLog.push(m) },
      terminate() {
        record.terminated = true
        if (terminateDelayMs == null) return undefined
        return new Promise((resolve) => setTimeout(() => { onTerminateResolved && onTerminateResolved(); resolve() }, terminateDelayMs))
      },
    }
  }
  return { spawnTransport, record }
}

// An EventEmitter-shaped flavor of the same fake, standing in for a worker_threads-style
// transport: messages/crashes are delivered by emitting 'message'/'error' rather than by
// calling the callbacks directly, and terminate() returns a delayed Promise (like the
// real worker_threads.Worker#terminate()) so the ensureAlive()-waits-for-terminate
// contract gets exercised against a shape other than a bare synchronous fake.
function makeEventEmitterTransport(spec = {}) {
  const { terminateDelayMs } = spec
  const record = { terminated: false, emitter: null }
  const spawnTransport = (callbacks) => {
    const emitter = new EventEmitter()
    emitter.on('message', callbacks.onMessage)
    emitter.on('error', (err) => callbacks.onCrash(err && err.message ? err.message : String(err)))
    record.emitter = emitter
    return {
      postMessage() {},
      terminate() {
        record.terminated = true
        if (terminateDelayMs == null) return undefined
        return new Promise((resolve) => setTimeout(() => resolve(1), terminateDelayMs))
      },
    }
  }
  return { spawnTransport, record }
}

// Wraps any of the factories above into a multi-generation spawnTransport: the Nth call
// (0-indexed) uses specs[min(N, specs.length-1)], and every spawned record is collected
// in order so a test can reach back into an old (superseded) generation's callbacks to
// simulate a straggler message, or hook spawn timing for ordering assertions.
function makeSequenced(factoryFn, specs, { onSpawn } = {}) {
  let idx = -1
  const spawned = []
  function spawnTransport(callbacks) {
    idx += 1
    onSpawn && onSpawn(idx)
    const spec = specs[Math.min(idx, specs.length - 1)]
    const { spawnTransport: inner, record } = factoryFn(spec)
    const t = inner(callbacks)
    spawned.push(record)
    return t
  }
  return { spawnTransport, spawned }
}

// Node's unsettled-top-level-await diagnostic can misfire against literal top-level
// `await` expressions racing a watchdog timer even when every promise genuinely settles;
// wrapping everything in a plain async function sidesteps it (same pattern as the
// existing test-pool-worker-hardening.js harness).
async function main() {
// --- lifecycle: generation / isDead / ensureAlive idempotency ----------------------
{
  const factory = makeSequenced(makeTransport, [{}])
  const slot = createWorkerSlot({ name: "[compiler] stage 'test' worker", spawnTransport: factory.spawnTransport })
  chk(slot.isDead() === true, 'a fresh, never-spawned slot reports isDead()===true — callers must go through ensureAlive() before using it')
  await slot.ensureAlive()
  chk(slot.generation === 1, `first ensureAlive() spawns generation 1 (got ${slot.generation})`)
  chk(slot.isDead() === false, 'slot is alive right after ensureAlive() resolves')
  await slot.ensureAlive()
  chk(factory.spawned.length === 1, `ensureAlive() on an already-alive slot is a no-op and must not respawn (spawned ${factory.spawned.length} times)`)
  chk(slot.generation === 1, 'generation is unchanged by the no-op ensureAlive() call')
  await slot.dispose()
}

// --- request() on a never-spawned slot rejects, does not hang ----------------------
{
  const factory = makeSequenced(makeTransport, [{}])
  const slot = createWorkerSlot({ name: 'w', spawnTransport: factory.spawnTransport })
  const err = await slot.request({ type: 'x' }, { timeoutMs: 1000, description: 'probe' }).then(() => null, (e) => e)
  chk(!!err && err.code === 'compiler-worker-dead', `request() before any ensureAlive() rejects with compiler-worker-dead (got ${err && err.code}) — a slot must never silently spawn on first use`)
}

// --- FIFO pairing: replies pair to the oldest pending request in arrival order ------
{
  const factory = makeSequenced(makeTransport, [{}])
  const slot = createWorkerSlot({ name: 'w', spawnTransport: factory.spawnTransport })
  await slot.ensureAlive()
  const p1 = slot.request({ id: 'A' }, { timeoutMs: 2000, description: 'req-A' })
  const p2 = slot.request({ id: 'B' }, { timeoutMs: 2000, description: 'req-B' })
  const cb = factory.spawned[0].callbacks
  cb.onMessage({ tag: 'first-arrival' })
  const r1 = await raceDelay(p1, 300)
  chk(r1.settled && r1.ok && r1.value.tag === 'first-arrival', `the first arriving message pairs to the oldest pending request, not the newest (got ${JSON.stringify(r1)})`)
  cb.onMessage({ tag: 'second-arrival' })
  const r2 = await raceDelay(p2, 300)
  chk(r2.settled && r2.ok && r2.value.tag === 'second-arrival', `the second arriving message pairs to the next pending request in FIFO order (got ${JSON.stringify(r2)})`)
  await slot.dispose()
}

// --- onEvent consumes out-of-band messages and still resets the watchdog -----------
{
  const factory = makeSequenced(makeTransport, [{}])
  const consumed = []
  const onEvent = (data) => {
    if (data && data.type === 'heartbeat') { consumed.push(data); return true }
    return false
  }
  const slot = createWorkerSlot({ name: 'w', spawnTransport: factory.spawnTransport, onEvent })
  await slot.ensureAlive()
  const p = slot.request({ id: 'A' }, { timeoutMs: 250, description: 'watchdog-probe' })
  const cb = factory.spawned[0].callbacks
  // 6 heartbeats @60ms = 360ms of elapsed real time, longer than the 250ms inactivity
  // window — if onEvent-consumed messages did not reset the watchdog, the request would
  // already be timed out by the time this loop finishes.
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 60))
    cb.onMessage({ type: 'heartbeat', n: i })
  }
  chk(consumed.length === 6, `onEvent consumed all 6 out-of-band heartbeats (got ${consumed.length})`)
  const stillPending = await raceDelay(p, 20)
  chk(stillPending.settled === false, 'the request is still pending after 360ms of heartbeat-only traffic — heartbeats consumed by onEvent must reset the inactivity watchdog, not just FIFO-paired replies')
  cb.onMessage({ id: 'A', reply: 'done' })
  const final = await raceDelay(p, 500)
  chk(final.settled && final.ok && final.value.reply === 'done', `the real reply still pairs correctly via FIFO after a run of consumed heartbeats (got ${JSON.stringify(final)})`)
  await slot.dispose()
}

// --- watchdog timeout: reject shape, immediate terminate, kills all pending --------
{
  const factory = makeSequenced(makeTransport, [{}])
  const slot = createWorkerSlot({ name: "[compiler] stage 'view' worker", spawnTransport: factory.spawnTransport })
  await slot.ensureAlive()
  const p1 = slot.request({ id: 'A' }, { timeoutMs: 150, description: 'compile-subset' })
  const p2 = slot.request({ id: 'B' }, { timeoutMs: 5000, description: 'second-in-flight' })
  const [e1, e2] = await withTimeout(Promise.all([
    p1.then(() => null, (e) => e),
    p2.then(() => null, (e) => e),
  ]), 3000, 'timeout scenario settling')
  chk(!!e1 && e1.code === 'compiler-worker-timeout', `a silent transport times out with code compiler-worker-timeout (got ${e1 && e1.code})`)
  chk(/timed out after 150ms/.test(String(e1 && e1.message)), `timeout error message names the configured timeoutMs (got: ${e1 && e1.message})`)
  chk(/'compile-subset'/.test(String(e1 && e1.message)), `timeout error message quotes the request description (got: ${e1 && e1.message})`)
  chk(String(e1 && e1.message).includes("[compiler] stage 'view' worker"), `timeout error message is prefixed with the slot's name (got: ${e1 && e1.message})`)
  chk(!!e2 && e2.code === 'compiler-worker-timeout', `every other pending request on the same slot is rejected too, same code (got ${e2 && e2.code}) — one dead transport kills all its in-flight requests`)
  chk(factory.spawned[0].terminated === true, 'transport.terminate() is called the instant the timeout is judged, not lazily on next use')
  chk(slot.isDead() === true, 'slot reports isDead()===true immediately after a watchdog timeout')
  await slot.dispose()
}

// --- request() on an already-dead (not yet respawned) slot: distinct code ----------
{
  const factory = makeSequenced(makeTransport, [{}])
  const slot = createWorkerSlot({ name: 'w', spawnTransport: factory.spawnTransport })
  await slot.ensureAlive()
  const p1 = slot.request({ id: 'A' }, { timeoutMs: 100, description: 'die' })
  await withTimeout(p1.then(() => null, (e) => e), 1000, 'initial death by timeout')
  const err = await slot.request({ id: 'B' }, { timeoutMs: 1000, description: 'after-death' }).then(() => null, (e) => e)
  chk(!!err && err.code === 'compiler-worker-dead', `a new request() on an already-dead, not-yet-respawned slot rejects immediately with compiler-worker-dead, distinct from the timeout code that killed it (got ${err && err.code}) — callers must call ensureAlive() before retrying`)
  await slot.dispose()
}

// --- onCrash: reject shape, immediate terminate --------------------------------------
{
  const factory = makeSequenced(makeTransport, [{}])
  const slot = createWorkerSlot({ name: 'w', spawnTransport: factory.spawnTransport })
  await slot.ensureAlive()
  const p = slot.request({ id: 'A' }, { timeoutMs: 5000, description: 'crash-probe' })
  factory.spawned[0].callbacks.onCrash('fake worker segfault')
  const err = await withTimeout(p.then(() => null, (e) => e), 2000, 'crash scenario settling')
  chk(!!err && err.code === 'compiler-worker-crashed', `onCrash judges the slot dead with code compiler-worker-crashed (got ${err && err.code})`)
  chk(/fake worker segfault/.test(String(err && err.message)), `crash error message carries the onCrash-provided reason (got: ${err && err.message})`)
  chk(factory.spawned[0].terminated === true, 'terminate() is called immediately on crash judgment, not lazily')
  chk(slot.isDead() === true, 'slot is dead immediately after onCrash')
  await slot.dispose()
}

// --- timeoutMs: Infinity disables the watchdog; only dispose() ends it -------------
{
  const factory = makeSequenced(makeTransport, [{}])
  const slot = createWorkerSlot({ name: 'w', spawnTransport: factory.spawnTransport })
  await slot.ensureAlive()
  const p = slot.request({ id: 'A' }, { timeoutMs: Infinity, description: 'no-watchdog' })
  const peek = await raceDelay(p, 300)
  chk(peek.settled === false, 'timeoutMs: Infinity disables the watchdog — the request must still be pending after 300ms of silence, not spuriously timed out')
  await slot.dispose()
  const after = await withTimeout(p.then(() => null, (e) => e), 1000, 'infinite-timeout request after dispose')
  chk(!!after && after.code === 'compiler-pool-disposed', `dispose() is the only thing that ends an Infinity-timeout request (code compiler-pool-disposed, got ${after && after.code})`)
}

// --- dispose(): terminate current transport, reject pending + future calls ---------
{
  const factory = makeSequenced(makeTransport, [{}])
  const slot = createWorkerSlot({ name: 'w', spawnTransport: factory.spawnTransport })
  await slot.ensureAlive()
  const pending = slot.request({ id: 'A' }, { timeoutMs: 5000, description: 'in-flight-at-dispose' })
  await slot.dispose()
  const pendingErr = await withTimeout(pending.then(() => null, (e) => e), 1000, 'in-flight request settling at dispose time')
  chk(!!pendingErr && pendingErr.code === 'compiler-pool-disposed', `dispose() rejects requests that were in flight at dispose time (got ${pendingErr && pendingErr.code})`)
  chk(factory.spawned[0].terminated === true, 'dispose() terminates the current transport')
  const afterErr = await slot.request({ id: 'B' }, { timeoutMs: 1000, description: 'post-dispose' }).then(() => null, (e) => e)
  chk(!!afterErr && afterErr.code === 'compiler-pool-disposed', `request() after dispose() rejects with compiler-pool-disposed (got ${afterErr && afterErr.code})`)
  const ensureOutcome = await slot.ensureAlive().then(() => null, (e) => e)
  chk(!!ensureOutcome && ensureOutcome.code === 'compiler-pool-disposed', `ensureAlive() after dispose() also refuses to respawn (got ${ensureOutcome && ensureOutcome.code})`)
}

// --- stale generation: a straggler message from a superseded transport is dropped ---
{
  const factory = makeSequenced(makeTransport, [{}, {}])
  const slot = createWorkerSlot({ name: 'w', spawnTransport: factory.spawnTransport })
  await slot.ensureAlive()
  const p1 = slot.request({ id: 'gen1' }, { timeoutMs: 120, description: 'gen1-req' })
  await withTimeout(p1.then(() => null, (e) => e), 1000, 'gen1 timeout settling')
  chk(slot.isDead() === true, 'slot is dead after the gen1 request times out (setup for the stale-drop scenario below)')
  await slot.ensureAlive()
  chk(slot.generation === 2, `respawn advances generation to 2 (got ${slot.generation})`)
  const p2 = slot.request({ id: 'gen2' }, { timeoutMs: 2000, description: 'gen2-req' })
  // simulates a straggler message arriving late from the terminated gen1 transport
  factory.spawned[0].callbacks.onMessage({ id: 'gen1', stale: true })
  const staleCheck = await raceDelay(p2, 100)
  chk(staleCheck.settled === false, 'a message delivered late from a superseded (gen1) transport must be dropped, not paired to the gen2 pending request')
  factory.spawned[1].callbacks.onMessage({ id: 'gen2', stale: false })
  const real = await withTimeout(p2, 1000, 'gen2 real reply settling')
  chk(real && real.stale === false, `the gen2 transport's own reply correctly pairs to the gen2 request once it arrives (got ${JSON.stringify(real)})`)
  await slot.dispose()
}

// --- ensureAlive() awaits a delayed terminate() Promise before respawning ----------
{
  const events = []
  let seq = 0
  const push = (label) => events.push({ seq: seq++, label })
  const factory = makeSequenced(makeTransport, [
    { terminateDelayMs: 80, onTerminateResolved: () => push('terminate-resolved:0') },
    {},
  ], { onSpawn: (idx) => push(`spawn:${idx}`) })
  const slot = createWorkerSlot({ name: 'w', spawnTransport: factory.spawnTransport })
  await slot.ensureAlive() // spawn:0
  const p = slot.request({ id: 'A' }, { timeoutMs: 100, description: 'force-death' })
  await withTimeout(p.then(() => null, (e) => e), 1000, 'force-death settling')
  await slot.ensureAlive() // must await terminate-resolved:0 before spawn:1
  const spawnIdx = events.findIndex((e) => e.label === 'spawn:1')
  const resolveIdx = events.findIndex((e) => e.label === 'terminate-resolved:0')
  chk(resolveIdx !== -1 && spawnIdx !== -1 && resolveIdx < spawnIdx,
    `ensureAlive() waits for the dead transport's delayed terminate() Promise to resolve before spawning the next generation (event order: ${events.map((e) => e.label).join(' -> ')}) — spawning early would let two live transports for the same slot coexist`)
  await slot.dispose()
}

// --- EventEmitter-shaped transport (worker_threads-like) satisfies the same contract ---
{
  const factory = makeSequenced(makeEventEmitterTransport, [{ terminateDelayMs: 50 }])
  const slot = createWorkerSlot({ name: 'w', spawnTransport: factory.spawnTransport })
  await slot.ensureAlive()
  const p = slot.request({ id: 'A' }, { timeoutMs: 120, description: 'ee-timeout' })
  const err = await withTimeout(p.then(() => null, (e) => e), 1000, 'eventemitter timeout settling')
  chk(!!err && err.code === 'compiler-worker-timeout', `an EventEmitter-shaped transport with a delayed-Promise terminate() (worker_threads-like) satisfies the same timeout contract (got ${err && err.code})`)
  chk(factory.spawned[0].terminated === true, 'terminate() is called immediately on timeout judgment for the EventEmitter-shaped transport too')
  await slot.dispose()
}
{
  const factory = makeSequenced(makeEventEmitterTransport, [{ terminateDelayMs: 50 }])
  const slot = createWorkerSlot({ name: 'w', spawnTransport: factory.spawnTransport })
  await slot.ensureAlive()
  const p = slot.request({ id: 'A' }, { timeoutMs: 5000, description: 'ee-crash' })
  factory.spawned[0].emitter.emit('error', new Error('ee crash reason'))
  const err = await withTimeout(p.then(() => null, (e) => e), 1000, 'eventemitter crash settling')
  chk(!!err && err.code === 'compiler-worker-crashed', `an EventEmitter-shaped transport also satisfies the onCrash ('error' event) contract (got ${err && err.code})`)
  chk(/ee crash reason/.test(String(err && err.message)), `the crash reason from the 'error' event reaches the rejection message (got: ${err && err.message})`)
  await slot.dispose()
}
{
  // Stale-drop must hold for the EventEmitter shape too: a superseded generation's
  // emitter keeps its 'message' listener wired to the old onMessage callback, so a
  // straggler emit is the realistic worker_threads late-delivery path.
  const factory = makeSequenced(makeEventEmitterTransport, [{ terminateDelayMs: 30 }, { terminateDelayMs: 30 }])
  const slot = createWorkerSlot({ name: 'w', spawnTransport: factory.spawnTransport })
  await slot.ensureAlive()
  const p1 = slot.request({ id: 'gen1' }, { timeoutMs: 120, description: 'ee-gen1-req' })
  await withTimeout(p1.then(() => null, (e) => e), 1000, 'ee gen1 timeout settling')
  await slot.ensureAlive()
  const p2 = slot.request({ id: 'gen2' }, { timeoutMs: 2000, description: 'ee-gen2-req' })
  factory.spawned[0].emitter.emit('message', { id: 'gen1', stale: true })
  const staleCheck = await raceDelay(p2, 100)
  chk(staleCheck.settled === false, 'a straggler emitted by a superseded EventEmitter transport is dropped, not paired to the new generation request')
  factory.spawned[1].emitter.emit('message', { id: 'gen2', stale: false })
  const real = await withTimeout(p2, 1000, 'ee gen2 real reply settling')
  chk(real && real.stale === false, `the live EventEmitter transport's reply still pairs correctly after a stale drop (got ${JSON.stringify(real)})`)
  await slot.dispose()
}

console.log(failed ? '\n❌ FAIL' : '\n✅ PASS: createWorkerSlot satisfies the generation/FIFO/watchdog/dispose contract')
}

// Set exitCode (not process.exit()) so the event loop drains and stdout/stderr flush
// before the process ends — process.exit() right after console.log can truncate output
// when stdout is piped (as it is under a test harness / captured shell).
main().then(
  () => { process.exitCode = failed ? 1 : 0 },
  (err) => { console.error('❌ FAIL (uncaught):', err); process.exitCode = 1 },
)
