// Supervised worker slot — the single authority both pools (src/pool.js browser,
// src/pool-node.js node) build on for "one live transport + FIFO request queue +
// inactivity watchdog + death/respawn". Keeping this state machine in one place is
// what makes "this pool forgot its timeout / its stale-reply guard" structurally
// impossible: a pool only describes how to spawn a transport, never how to supervise it.
//
// Liveness model: a request's watchdog measures INACTIVITY, not total duration. Any
// message from the current transport (a FIFO-paired reply, a forwarded log, a heartbeat
// consumed by onEvent) resets every pending request's timer. Only `timeoutMs` of total
// silence judges the worker dead — so a slow-but-alive compile is never killed, while a
// truly wedged worker (a synchronous wasm loop blocks its event loop, silencing even
// heartbeats) is caught within one window.
//
// Death model: judgment (timeout / crash / postMessage throw) is atomic — every pending
// request rejects with the same coded error, the transport is terminate()d THAT INSTANT
// (a busy-looping wasm worker must not keep burning a core until someone compiles again),
// and the slot goes dead. Respawn stays lazy: the next ensureAlive() first awaits the
// dead transport's terminate() settlement (worker_threads returns a Promise — until it
// resolves the old worker may still be writing shared disk), then spawns the next
// generation. Messages from a superseded generation are dropped, never FIFO-paired.

// Await every promise (so no request is left in flight across an attempt boundary —
// a retry must never overlap the previous attempt's traffic), then surface the first
// failure. Plain Promise.all would reject early and leave siblings dangling.
export async function settleAll(promises) {
  const settled = await Promise.all(promises.map((p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }))))
  const bad = settled.find((r) => !r.ok)
  if (bad) throw bad.e
  return settled.map((r) => r.v)
}

/**
 * @param {{
 *   name: string,  // error-message prefix, e.g. "[compiler] stage 'view' worker"
 *   spawnTransport: (cb: { onMessage: (data:any)=>void, onCrash: (message:string)=>void })
 *     => { postMessage: (m:any)=>void, terminate: ()=>(void|Promise<any>) },
 *   onEvent?: (data:any) => boolean,  // true = out-of-band, consumed (still counts as liveness)
 * }} options
 */
export function createWorkerSlot({ name, spawnTransport, onEvent }) {
  let transport = null
  let generation = 0
  let dead = true            // a fresh slot is dead until the first ensureAlive()
  let disposed = false
  let pending = []           // FIFO of { resolve, reject, timeoutMs, description, timer }
  let terminationAck = Promise.resolve() // settles when the latest terminate() has settled
  let reviving = null        // in-flight ensureAlive(), so concurrent callers share one respawn

  const codedError = (message, code) => Object.assign(new Error(message), { code })
  const disposedError = () => codedError(`${name}: pool has been disposed`, 'compiler-pool-disposed')

  function armTimer(entry) {
    if (!(entry.timeoutMs < Infinity)) return
    // Deliberately NOT unref()'d (browsers have no such concept; in Node an unref()'d
    // watchdog would let an otherwise-idle process exit before it ever fires, silently
    // defeating the whole timeout).
    entry.timer = setTimeout(() => {
      judgeDead(
        `${name} timed out after ${entry.timeoutMs}ms waiting for a reply to '${entry.description}'`,
        'compiler-worker-timeout',
      )
    }, entry.timeoutMs)
  }

  function clearTimer(entry) {
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = null }
  }

  // Atomic death judgment: reject everything in flight with one coded error, terminate
  // the transport immediately, and remember the terminate() settlement so the next
  // respawn (or a retrying caller) can't overlap with a still-dying worker.
  function judgeDead(message, code) {
    if (dead || disposed) return
    dead = true
    const t = transport
    transport = null
    const doomed = pending
    pending = []
    for (const e of doomed) { clearTimer(e); e.reject(codedError(message, code)) }
    terminationAck = settleTerminate(t)
  }

  function settleTerminate(t) {
    if (!t) return Promise.resolve()
    try {
      return Promise.resolve(t.terminate()).then(() => {}, () => {})
    } catch { return Promise.resolve() }
  }

  function handleMessage(gen, data) {
    if (disposed || dead || gen !== generation) return // stale generation or dead: drop
    let consumed = false
    if (onEvent) {
      try { consumed = onEvent(data) === true } catch { consumed = true }
    }
    // Any message from the live transport is proof of life — restart every pending
    // request's inactivity window, whether or not this message pairs with one.
    for (const e of pending) { clearTimer(e); armTimer(e) }
    if (consumed) return
    const e = pending.shift()
    if (e) { clearTimer(e); e.resolve(data) }
  }

  function handleCrash(gen, message) {
    if (disposed || dead || gen !== generation) return
    judgeDead(message, 'compiler-worker-crashed')
  }

  function ensureAlive() {
    if (disposed) return Promise.reject(disposedError())
    if (!dead) return Promise.resolve()
    if (!reviving) {
      const p = (async () => {
        await terminationAck
        if (disposed) throw disposedError()
        if (!dead) return
        generation += 1
        const gen = generation
        transport = spawnTransport({
          onMessage: (data) => handleMessage(gen, data),
          onCrash: (message) => handleCrash(gen, message),
        })
        dead = false
      })()
      reviving = p
      // Clear the memo through a never-rejecting branch (a bare .finally() would mint a
      // new unobserved rejection); callers still see p's own rejection.
      const clear = () => { if (reviving === p) reviving = null }
      p.then(clear, clear)
    }
    return reviving
  }

  function request(msg, { timeoutMs, description }) {
    return new Promise((resolve, reject) => {
      if (disposed) return reject(disposedError())
      if (dead) {
        return reject(codedError(
          `${name} is dead — ensureAlive() must run before request()`,
          'compiler-worker-dead',
        ))
      }
      const entry = { resolve, reject, timeoutMs, description, timer: null }
      pending.push(entry)
      armTimer(entry)
      try {
        transport.postMessage(msg)
      } catch (err) {
        judgeDead(`${name} postMessage failed: ${(err && err.message) || err}`, 'compiler-worker-crashed')
      }
    })
  }

  // Idle reclamation: terminate the live transport to release its memory while keeping
  // the slot usable — the next ensureAlive() respawns a fresh generation, exactly like
  // recovery after a death. Refuses to act under in-flight traffic (a shrink must never
  // reject a pending request; the pool only shrinks a drained queue). Returns the
  // terminate() settlement so a caller CAN await full teardown, but never has to.
  function shrink() {
    if (disposed || dead || pending.length) return terminationAck
    dead = true
    const t = transport
    transport = null
    terminationAck = settleTerminate(t)
    return terminationAck
  }

  async function dispose() {
    if (disposed) return
    disposed = true
    const t = transport
    transport = null
    dead = true
    const doomed = pending
    pending = []
    for (const e of doomed) { clearTimer(e); e.reject(disposedError()) }
    await settleTerminate(t)
    await terminationAck
  }

  return {
    get generation() { return generation },
    isDead: () => dead,
    ensureAlive,
    request,
    shrink,
    dispose,
  }
}
