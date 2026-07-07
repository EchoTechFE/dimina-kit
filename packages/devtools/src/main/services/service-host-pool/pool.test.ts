/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-this-alias --
   Mock-heavy contract test: WebContents / debugger / pool internals are stubbed with
   ad-hoc `any` shapes and a `this` alias inside a fake class — test scaffolding, not
   production typing. */
/**
 * Contract spec for the ServiceHostPool main-process singleton described in
 * docs/prewarm-webview.md (design v0.1) and implemented in `./pool.ts`. These
 * tests pin the documented contract (API surface, state machine, reset
 * checklist, and edge cases from prewarm-webview.md).
 *
 * Several assertions pin the strict form of the contract — webPreferences
 * parity, init crash-resilience, crash-destroys-window, navigate-
 * before-clear ordering, and resize evicts-oldest-first — alongside further
 * hardening checks covering render-process-gone refill occupancy, pool-size
 * clamping, storage-bucket coverage, and destroyed-window handling. Do NOT
 * relax these to make them pass — fix the impl instead.
 *
 * ── Construction API assumption (shape (a)) ─────────────────────────────────
 *   const pool = new ServiceHostPool()
 *   await pool.init({ defaultPoolSize, defaultSpec })   // pre-warms entries
 * Rationale: the doc's ServiceHostPoolService surface is `init(opts: {
 * defaultPoolSize; defaultSpec })`, so the pool mirrors it. `init()`'s returned
 * Promise MUST NOT resolve until the initial `defaultPoolSize` entries have
 * reached the `ready` state (i.e. warming has settled): `await pool.init(...)`
 * ⇒ getStats().ready === defaultPoolSize.
 *
 * ── Warming-settle assumption ──────────────────────────────────────────────
 * An entry's warming → ready transition is driven by the window's webContents
 * `'did-finish-load'` event. Our electron mock's `loadURL`/`loadFile` resolve
 * immediately AND we synthetically fire any captured `'did-finish-load'`
 * handler (via fireDidFinishLoad below) so warming can complete deterministically.
 * To stay robust against either driver, `init()`/`acquire()` settle once both
 * the load Promise resolves and (if registered) the did-finish-load handler has
 * been invoked. Warming is observable through `getStats()` and resolvable
 * through the awaited init/acquire Promises — tests never read private fields.
 *
 * ── render-process-gone refill observation ─────────────────────────────────
 * We capture the webContents `'render-process-gone'` handler via the mocked
 * `on(...)`. Firing it must (1) remove the dead entry and (2) trigger a refill
 * back to the pool's target size — observed as a NEW BrowserWindow construction
 * + a fresh warming/ready entry in getStats(). The pool registers a
 * `'render-process-gone'` listener on each pooled window's webContents.
 *
 * partition note: the doc's type/state-machine section and reset-checklist
 * section contradict each other (`persist:simulator` vs
 * `persist:simulator:pool-${id}`). Tests treat spec.partition as opaque and
 * never hard-assert its value. Spec identity for reuse is keyed on preloadPath.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── electron mock ──────────────────────────────────────────────────────────
// Module-scope registry of every BrowserWindow ever constructed, plus the
// captured per-window event handlers, so tests can (a) count constructions and
// (b) drive load / crash events deterministically.

type Handlers = Record<string, Array<(...args: any[]) => void>>

type StubWebContents = {
  id: number
  destroyed: boolean
  isDestroyed: () => boolean
  loadURL: ReturnType<typeof vi.fn>
  loadFile: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  once: ReturnType<typeof vi.fn>
  openDevTools: ReturnType<typeof vi.fn>
  session: any
  __handlers: Handlers
}

type StubWindow = {
  webContents: StubWebContents
  close: ReturnType<typeof vi.fn>
  destroy: ReturnType<typeof vi.fn>
  isDestroyed: ReturnType<typeof vi.fn>
  setBounds: ReturnType<typeof vi.fn>
  // Window-level event registration (`win.once('closed', …)` / `win.on(...)`),
  // distinct from the webContents handlers above. Recorded so the
  // graceful-close-leak tests can fire the pool's `'closed'` reclaim hook.
  on: ReturnType<typeof vi.fn>
  once: ReturnType<typeof vi.fn>
  __winHandlers: Handlers
  __destroyed: boolean
  // Full BrowserWindow constructor opts, captured so tests can assert
  // webPreferences parity with the real service-host window.
  __opts: any
}

const constructed: StubWindow[] = []
// Per-partition stub session, so reset assertions can inspect clearStorageData.
const sessions = new Map<string, any>()
const clearStorageData = vi.fn(() => {
  orderLog.push('clearStorageData') // storage-clear marker
  return Promise.resolve()
})
const clearCache = vi.fn(() => Promise.resolve())

// ── invocation-order log ─────────────────────────────────────────────────────
// The mock's loadURL / clearStorageData push a label here so a test can assert
// the reset path navigates (loadURL) BEFORE it clears storage. Tests that ignore
// it are unaffected; cleared in beforeEach.
const orderLog: string[] = []

// ── opt-in deferred-load mode ────────────────────────────────────────────────
// When `deferLoads` is true, every `loadURL` returns a Promise parked in
// `pendingLoads` that the test resolves manually via `resolveAllLoads()`. When
// false (the DEFAULT) loads resolve immediately, so tests that never touch these
// keep their immediate-resolution behavior.
let deferLoads = false
const pendingLoads: Array<() => void> = []
// Resolve the `n` earliest parked loads (FIFO; refill loads are appended later,
// so the initial-warm loads are at the front). Returns how many it resolved.
function resolveLoads(n: number): number {
  const batch = pendingLoads.splice(0, n)
  for (const resolve of batch) resolve()
  return batch.length
}
function resolveAllLoads(): void {
  // Drain in waves: resolving a load can trigger a refill that registers more
  // pending loads, so keep going until the queue is stable.
  while (pendingLoads.length > 0) {
    const batch = pendingLoads.splice(0, pendingLoads.length)
    for (const resolve of batch) resolve()
  }
}

vi.mock('electron', () => {
  let nextId = 1
  class BrowserWindow {
    webContents: StubWebContents
    close: ReturnType<typeof vi.fn>
    destroy: ReturnType<typeof vi.fn>
    isDestroyed: ReturnType<typeof vi.fn>
    setBounds = vi.fn()
    // Window-level event handlers (e.g. `win.once('closed', …)`).
    on: ReturnType<typeof vi.fn>
    once: ReturnType<typeof vi.fn>
    __winHandlers: Handlers
    __destroyed = false
    __opts: any
    constructor(opts: any) {
      const id = nextId++
      const handlers: Handlers = {}
      // Separate registry for window-level (not webContents) handlers.
      const winHandlers: Handlers = {}
      const self = this
      // Keep the full constructor opts for webPreferences parity checks.
      this.__opts = opts
      this.__winHandlers = winHandlers
      this.on = vi.fn((evt: string, cb: (...a: any[]) => void) => {
        ;(winHandlers[evt] ||= []).push(cb)
        return self
      })
      this.once = vi.fn((evt: string, cb: (...a: any[]) => void) => {
        ;(winHandlers[evt] ||= []).push(cb)
        return self
      })
      this.webContents = {
        id,
        destroyed: false,
        isDestroyed() { return this.destroyed },
        loadURL: vi.fn(() => {
          orderLog.push('loadURL') // navigate marker
          if (deferLoads) {
            return new Promise<void>((resolve) => { pendingLoads.push(resolve) })
          }
          return Promise.resolve()
        }),
        loadFile: vi.fn(() => {
          orderLog.push('loadURL')
          if (deferLoads) {
            return new Promise<void>((resolve) => { pendingLoads.push(resolve) })
          }
          return Promise.resolve()
        }),
        on: vi.fn((evt: string, cb: (...a: any[]) => void) => {
          ;(handlers[evt] ||= []).push(cb)
        }),
        once: vi.fn((evt: string, cb: (...a: any[]) => void) => {
          ;(handlers[evt] ||= []).push(cb)
        }),
        openDevTools: vi.fn(),
        session: {
          clearStorageData,
          clearCache,
          clearHostResolverCache: vi.fn(() => Promise.resolve()),
          clearAuthCache: vi.fn(() => Promise.resolve()),
          setPermissionRequestHandler: vi.fn(),
          webRequest: { onHeadersReceived: vi.fn() },
        },
        __handlers: handlers,
      }
      this.close = vi.fn(() => {
        self.__destroyed = true
        self.webContents.destroyed = true
      })
      this.destroy = vi.fn(() => {
        self.__destroyed = true
        self.webContents.destroyed = true
      })
      this.isDestroyed = vi.fn(() => self.__destroyed)
      constructed.push(this as unknown as StubWindow)
    }
  }
  const sessionFromPartition = vi.fn((p: string) => {
    let s = sessions.get(p)
    if (!s) {
      s = {
        clearStorageData,
        clearCache,
        clearHostResolverCache: vi.fn(() => Promise.resolve()),
        clearAuthCache: vi.fn(() => Promise.resolve()),
        setPermissionRequestHandler: vi.fn(),
        webRequest: { onHeadersReceived: vi.fn() },
      }
      sessions.set(p, s)
    }
    return s
  })
  return {
    BrowserWindow,
    app: { whenReady: vi.fn(() => Promise.resolve()), on: vi.fn() },
    session: { fromPartition: sessionFromPartition },
  }
})

// Import AFTER the mock so the SUT binds the stubs.
import { ServiceHostPool } from './pool.js'

// ── helpers ────────────────────────────────────────────────────────────────

const PRELOAD_A = '/abs/path/preload-a.js'
const PRELOAD_B = '/abs/path/preload-b.js'

function specA(): any {
  return {
    partition: 'persist:simulator',
    preloadPath: PRELOAD_A,
    size: { width: 375, height: 812 },
    devTools: false,
  }
}
function specB(): any {
  return { partition: 'persist:simulator', preloadPath: PRELOAD_B }
}

// Fire the captured did-finish-load handler on every window that has one but
// hasn't been "loaded" yet, so warming can settle whether ready is gated on the
// event or on the loadURL Promise. Safe to call repeatedly. Returns the number
// of handlers fired.
function fireDidFinishLoadAll(): number {
  let fired = 0
  for (const w of constructed) {
    const hs = w.webContents.__handlers['did-finish-load'] || []
    for (const h of hs) { h(); fired++ }
  }
  return fired
}

function fireRenderProcessGone(win: StubWindow): number {
  const hs = win.webContents.__handlers['render-process-gone'] || []
  for (const h of hs) h({ reason: 'crashed' })
  return hs.length
}

// Fire the window-level `'closed'` handlers the pool registers via
// `win.once('closed', …)`. Mirrors fireRenderProcessGone but reads the
// window-level registry. Returns how many handlers ran.
function fireClosed(win: StubWindow): number {
  const hs = win.__winHandlers['closed'] || []
  for (const h of hs) h()
  return hs.length
}

// Let microtasks + a macrotask drain so async warming/refill settles.
async function flush(): Promise<void> {
  await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
  fireDidFinishLoadAll()
  await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
}

beforeEach(() => {
  constructed.length = 0
  sessions.clear()
  clearStorageData.mockClear()
  clearCache.mockClear()
  // Reset the order-log / deferred-load mock state so each test starts from the
  // default immediate-load behavior with an empty order log.
  orderLog.length = 0
  deferLoads = false
  pendingLoads.length = 0
})

// ── tests ──────────────────────────────────────────────────────────────────

describe('ServiceHostPool — state machine (warming → ready → in-use → resetting → ready)', () => {
  // Contract point 1.
  it('warms init entries to ready, then acquire→in-use and release→resetting→ready', async () => {
    const pool = new ServiceHostPool()
    const initP = pool.init({ defaultPoolSize: 1, defaultSpec: specA() })
    // Drive the load event in case init() awaits did-finish-load.
    fireDidFinishLoadAll()
    await initP

    let stats = pool.getStats()
    expect(stats.ready).toBe(1)
    expect(stats.warming).toBe(0)
    expect(stats.inUse).toBe(0)
    expect(stats.total).toBe(1)

    const { win, entryId } = await pool.acquire(specA())
    expect(win).toBeTruthy()
    expect(entryId).not.toBeNull() // came from the pool, not a fallback create

    stats = pool.getStats()
    expect(stats.inUse).toBe(1)
    expect(stats.ready).toBe(0)

    // Isolate the reset path's invocation order — only events from here on
    // belong to the reset. The doc requires navigate-to-blank FIRST, then
    // clear storage.
    orderLog.length = 0
    const relP = pool.release(entryId, win as any)
    // reset path navigates to about:blank then waits for did-finish-load.
    fireDidFinishLoadAll()
    await relP
    await flush()

    // Reset must actually clear storage on the way back to ready.
    expect(clearStorageData).toHaveBeenCalled()

    // The FIRST navigate must precede the FIRST storage clear.
    const firstLoad = orderLog.indexOf('loadURL')
    const firstClear = orderLog.indexOf('clearStorageData')
    expect(firstLoad).toBeGreaterThanOrEqual(0)
    expect(firstClear).toBeGreaterThanOrEqual(0)
    expect(firstLoad).toBeLessThan(firstClear)

    // Reset must hit the documented storage buckets (prewarm-webview.md's
    // required rows) and clear the HTTP cache.
    expect(clearStorageData).toHaveBeenCalledWith({
      storages: expect.arrayContaining([
        'cookies',
        'localstorage',
        'indexdb',
        'serviceworkers',
        'cachestorage',
      ]),
    })
    expect(clearCache).toHaveBeenCalled()

    stats = pool.getStats()
    expect(stats.inUse).toBe(0)
    expect(stats.ready).toBe(1)
    expect(stats.resetting).toBe(0)
  })
})

describe('ServiceHostPool — webPreferences parity', () => {
  // The pooled window must carry the SAME process-model flags as the real
  // service-host window it replaces (create.ts:19-32): sandbox/contextIsolation/
  // nodeIntegration all explicit, plus preload + partition from the spec.
  it('constructs pooled windows with the service-host process-model flags', async () => {
    const spec = specA()
    const pool = new ServiceHostPool()
    const initP = pool.init({ defaultPoolSize: 1, defaultSpec: spec })
    fireDidFinishLoadAll()
    await initP

    expect(constructed.length).toBeGreaterThanOrEqual(1)
    const wp = constructed[constructed.length - 1]!.__opts?.webPreferences
    expect(wp).toBeTruthy()
    // Process-model parity with createServiceHostWindow (create.ts:24-30).
    expect(wp.sandbox).toBe(false)
    expect(wp.contextIsolation).toBe(false)
    expect(wp.nodeIntegration).toBe(false)
    // Spec-derived fields.
    expect(wp.preload).toBe(spec.preloadPath)
    expect(wp.partition).toBe(spec.partition)
  })
})

describe('ServiceHostPool — acquire', () => {
  // Contract point 2.
  it('acquire from a ready pool does NOT construct a new BrowserWindow', async () => {
    const pool = new ServiceHostPool()
    const initP = pool.init({ defaultPoolSize: 1, defaultSpec: specA() })
    fireDidFinishLoadAll()
    await initP

    const builtAfterInit = constructed.length
    expect(builtAfterInit).toBeGreaterThanOrEqual(1)

    const { entryId } = await pool.acquire(specA())
    expect(entryId).not.toBeNull()
    // Behavioral assertion: no new window was constructed for this acquire.
    expect(constructed.length).toBe(builtAfterInit)
  })

  // Contract point 3.
  it('acquire from an empty pool falls back to a fresh window with entryId === null', async () => {
    const pool = new ServiceHostPool()
    const initP = pool.init({ defaultPoolSize: 1, defaultSpec: specA() })
    fireDidFinishLoadAll()
    await initP

    // Drain the single ready entry.
    const first = await pool.acquire(specA())
    expect(first.entryId).not.toBeNull()

    const builtBefore = constructed.length

    // Pool is now empty of ready entries → fallback synchronous create.
    const fallbackP = pool.acquire(specA())
    fireDidFinishLoadAll()
    const fallback = await fallbackP

    expect(fallback.entryId).toBeNull()
    expect(fallback.win).toBeTruthy()
    expect(constructed.length).toBeGreaterThan(builtBefore)
  })
})

describe('ServiceHostPool — release', () => {
  // Contract point 4.
  it('releasing a fallback window (entryId === null) destroys it and does not pool it', async () => {
    const pool = new ServiceHostPool()
    const initP = pool.init({ defaultPoolSize: 1, defaultSpec: specA() })
    fireDidFinishLoadAll()
    await initP

    // Drain ready entry, then force a fallback create.
    await pool.acquire(specA())
    const fb = await (async () => {
      const p = pool.acquire(specA())
      fireDidFinishLoadAll()
      return p
    })()
    expect(fb.entryId).toBeNull()

    const readyBefore = pool.getStats().ready
    const totalBefore = pool.getStats().total
    const fbWin = fb.win as unknown as StubWindow

    await pool.release(null, fb.win as any)
    await flush()

    // The fallback window must be torn down.
    const destroyed =
      fbWin.close.mock.calls.length > 0 ||
      fbWin.destroy.mock.calls.length > 0 ||
      fbWin.__destroyed === true
    expect(destroyed).toBe(true)

    // A fallback window (entryId === null) was never in the pool, so neither
    // the total nor the ready count may change on its release. Exact, not <=:
    // catches a fallback being wrongly re-pooled as warming/resetting (total
    // grows while ready stays put).
    expect(pool.getStats().total).toBe(totalBefore)
    expect(pool.getStats().ready).toBe(readyBefore)
  })

  // Contract point 5.
  it('releasing an entry whose spec no longer matches the pool spec disposes it (not kept ready)', async () => {
    // Initialize the pool with spec A, acquire from it, then change the pool's
    // current spec to B (preloadPath mismatch) by acquiring with spec B — which
    // which destroys mismatched entries and rebuilds (see prewarm-webview.md).
    // On release of the old
    // (spec A) entry, the entry must transition to disposing, not ready.
    const pool = new ServiceHostPool()
    const initP = pool.init({ defaultPoolSize: 1, defaultSpec: specA() })
    fireDidFinishLoadAll()
    await initP

    const a = await pool.acquire(specA())
    expect(a.entryId).not.toBeNull()

    // Acquire with a different preloadPath: pool's current spec becomes B.
    const bP = pool.acquire(specB())
    fireDidFinishLoadAll()
    await bP
    await flush()

    const readyBefore = pool.getStats().ready
    const totalBefore = pool.getStats().total

    // Now return the stale spec-A entry. It must NOT be re-added as ready.
    const relP = pool.release(a.entryId, a.win as any)
    fireDidFinishLoadAll()
    await relP
    await flush()

    // The mismatched entry must leave the pool entirely — total drops by
    // exactly one and ready is unchanged. Exact assertions (not <=) catch the
    // entry being wrongly re-pooled as warming/resetting (total would grow while
    // ready stayed flat).
    expect(pool.getStats().total).toBe(totalBefore - 1)
    expect(pool.getStats().ready).toBe(readyBefore)
    // And its window was torn down.
    const aWin = a.win as unknown as StubWindow
    const torn =
      aWin.close.mock.calls.length > 0 ||
      aWin.destroy.mock.calls.length > 0 ||
      aWin.__destroyed === true
    expect(torn).toBe(true)
  })

  // New spec field: ServiceHostSpec.clearStorageOnReset (default true). When false,
  // the reset path must STILL navigate the released window to blank (tearing down
  // the old document/JS realm) but MUST NOT touch the shared session — no
  // clearStorageData, no clearCache. Rationale: a pooled service-host window
  // shares `persist:simulator` with live projects; clearing it would wipe their
  // (appId-namespaced, navigation-reset) storage.
  it('release with clearStorageOnReset:false navigates to blank but does NOT clear storage', async () => {
    const spec = { ...specA(), clearStorageOnReset: false }
    const pool = new ServiceHostPool()
    const initP = pool.init({ defaultPoolSize: 1, defaultSpec: spec })
    fireDidFinishLoadAll()
    await initP

    const { win, entryId } = await pool.acquire(spec)
    expect(entryId).not.toBeNull()
    expect(pool.getStats().inUse).toBe(1)

    // Isolate the reset path: only events from here on belong to release.
    clearStorageData.mockClear()
    clearCache.mockClear()
    orderLog.length = 0

    const relP = pool.release(entryId, win as any)
    fireDidFinishLoadAll()
    await relP
    await flush()

    // The shared session must be left untouched.
    expect(clearStorageData).not.toHaveBeenCalled()
    expect(clearCache).not.toHaveBeenCalled()
    // But the window WAS navigated to blank during reset.
    expect(orderLog).toContain('loadURL')

    // The entry returned to the pool.
    const stats = pool.getStats()
    expect(stats.ready).toBe(1)
    expect(stats.inUse).toBe(0)
    expect(stats.resetting).toBe(0)
  })
})

describe('ServiceHostPool — resize', () => {
  // Contract point 6.
  it('resize(0) disposes all entries and drops total/ready to 0', async () => {
    const pool = new ServiceHostPool()
    const initP = pool.init({ defaultPoolSize: 3, defaultSpec: specA() })
    fireDidFinishLoadAll()
    await initP

    expect(pool.getStats().ready).toBe(3)

    pool.resize(0)
    await flush()

    const stats = pool.getStats()
    expect(stats.total).toBe(0)
    expect(stats.ready).toBe(0)
  })

  // Shrinking to k>0 must evict the OLDEST entries first and keep the k
  // most-recently-created. `constructed` is in creation order, so the last
  // element is the newest.
  it('resize(3 → 1) disposes the two OLDEST windows and keeps the newest', async () => {
    const pool = new ServiceHostPool()
    const initP = pool.init({ defaultPoolSize: 3, defaultSpec: specA() })
    fireDidFinishLoadAll()
    await initP

    expect(pool.getStats().ready).toBe(3)
    expect(constructed.length).toBe(3)
    const [oldest, middle, newest] = constructed

    pool.resize(1)
    await flush()

    const wasTornDown = (w: StubWindow) =>
      w.close.mock.calls.length > 0 ||
      w.destroy.mock.calls.length > 0 ||
      w.__destroyed === true

    // The two oldest must be gone; the newest must survive.
    expect(wasTornDown(oldest!)).toBe(true)
    expect(wasTornDown(middle!)).toBe(true)
    expect(wasTornDown(newest!)).toBe(false)

    const stats = pool.getStats()
    expect(stats.total).toBe(1)
    expect(stats.ready).toBe(1)
  })
})

describe('ServiceHostPool — render-process-gone', () => {
  // Contract point 7.
  it('a crashed pooled window is removed and the pool refills back to target size', async () => {
    const pool = new ServiceHostPool()
    const initP = pool.init({ defaultPoolSize: 1, defaultSpec: specA() })
    fireDidFinishLoadAll()
    await initP

    expect(pool.getStats().ready).toBe(1)
    const builtBefore = constructed.length

    // The single pooled window is the most recently constructed one.
    const pooledWin = constructed[constructed.length - 1]!
    const handlerCount = fireRenderProcessGone(pooledWin)
    // The pool MUST have registered a render-process-gone listener.
    expect(handlerCount).toBeGreaterThan(0)

    // Let the refill warm up.
    await flush()

    // onGone must tear down the crashed BrowserWindow, not just delete the
    // entry from the map. A leaked window is a leaked render process — the
    // crashed window MUST be destroyed/closed.
    const crashedTornDown =
      pooledWin.destroy.mock.calls.length > 0 ||
      pooledWin.close.mock.calls.length > 0 ||
      pooledWin.__destroyed === true
    expect(crashedTornDown).toBe(true)

    // Exact occupancy after the refill settles (target = 1). Combined with the
    // teardown assertion above, this fully pins the total/destroy story.
    const stats = pool.getStats()
    expect(stats.total).toBe(1)
    expect(stats.ready).toBe(1)
    // Exactly one new window was constructed to replace the dead one.
    expect(constructed.length).toBe(builtBefore + 1)
  })

  // F2: init must not resolve until the target is genuinely met — even if a
  // warming window's render process dies mid-init. Uses opt-in deferred loads
  // so the timing is deterministic: we control exactly which loads settle and
  // when, and observe init's resolution via a sentinel.
  //
  // Sequence:
  //   1. deferLoads on → init({size: 2}) parks load_1, load_2 (the initial-warm
  //      snapshot).
  //   2. crash window_1 → onGone removes entry_1 and refills entry_3, which
  //      parks load_3 (NOT part of the initial snapshot).
  //   3. resolve ONLY load_1 + load_2 and drain microtasks. init must still be
  //      pending here — entry_3 is not yet ready, so the target of 2 is unmet.
  //      Pins that init awaits the refill too, not just the initial snapshot.
  //   4. resolve the refill load too, await init, assert the target is met.
  it('init does not resolve while a crash-refill is still warming (target met before resolve)', async () => {
    deferLoads = true
    const pool = new ServiceHostPool()

    let initDone = false
    const initP = pool.init({ defaultPoolSize: 2, defaultSpec: specA() }).then(() => {
      initDone = true
    })

    // Two initial warms are now parked (load_1, load_2).
    expect(constructed.length).toBe(2)
    expect(pendingLoads.length).toBe(2)

    // Crash the FIRST warming window. The pool drops it and refills (entry_3),
    // parking a third load.
    const crashed = constructed[0]!
    const handlerCount = fireRenderProcessGone(crashed)
    expect(handlerCount).toBeGreaterThan(0)
    // (The crashed window's teardown is pinned separately by the F3 test; this
    // test deliberately focuses on init's resolution timing.)

    // The refill constructed a replacement and parked its load.
    expect(constructed.length).toBe(3)
    expect(pendingLoads.length).toBe(3)

    // Resolve ONLY the two initial-warm loads. The refill load stays parked.
    expect(resolveLoads(2)).toBe(2)
    // Drain microtasks so any awaited Promise.all / .then settles.
    await Promise.resolve()
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))

    // Checkpoint: with the refill still warming, the target of 2 ready is NOT
    // yet met, so init MUST still be pending — it cannot resolve on the initial
    // snapshot alone.
    expect(initDone).toBe(false)

    // Now let the refill finish loading and settle init.
    resolveAllLoads()
    fireDidFinishLoadAll()
    await initP

    const stats = pool.getStats()
    expect(stats.ready).toBe(2)
    expect(stats.warming).toBe(0)
    expect(stats.total).toBe(2)
  })
})

describe('ServiceHostPool — maxPoolSize cap (F8)', () => {
  // F8(a): the hard cap is 4 (doc §3.3). A requested size above it is clamped.
  it('clamps defaultPoolSize/maxPoolSize to the hard cap of 4', async () => {
    const pool = new ServiceHostPool()
    const initP = pool.init({ defaultPoolSize: 10, maxPoolSize: 10, defaultSpec: specA() })
    fireDidFinishLoadAll()
    await initP

    const stats = pool.getStats()
    expect(stats.ready).toBe(4)
    expect(stats.total).toBe(4)
  })

  // F8(b): releasing entries must never grow the pool past maxPoolSize; any
  // over-cap window is dropped/destroyed rather than re-pooled (doc §3.3
  // 「超 maxPoolSize → close」).
  it('never re-pools above maxPoolSize on release', async () => {
    const pool = new ServiceHostPool()
    const initP = pool.init({ defaultPoolSize: 2, maxPoolSize: 2, defaultSpec: specA() })
    fireDidFinishLoadAll()
    await initP
    expect(pool.getStats().ready).toBe(2)

    // Acquire both ready entries → pool drained, both in-use.
    const a1 = await pool.acquire(specA())
    const a2 = await pool.acquire(specA())
    expect(a1.entryId).not.toBeNull()
    expect(a2.entryId).not.toBeNull()
    expect(pool.getStats().ready).toBe(0)

    // Release both. The cap invariant (ready ≤ maxPoolSize) must hold after each.
    const r1 = pool.release(a1.entryId, a1.win as any)
    fireDidFinishLoadAll()
    await r1
    await flush()
    expect(pool.getStats().ready).toBeLessThanOrEqual(2)

    const r2 = pool.release(a2.entryId, a2.win as any)
    fireDidFinishLoadAll()
    await r2
    await flush()

    // Final: never exceeded the cap; total likewise bounded by the cap.
    const stats = pool.getStats()
    expect(stats.ready).toBeLessThanOrEqual(2)
    expect(stats.total).toBeLessThanOrEqual(2)
  })
})

describe('ServiceHostPool — dispose', () => {
  it('dispose() tears down all entries (total drops to 0)', async () => {
    const pool = new ServiceHostPool()
    const initP = pool.init({ defaultPoolSize: 2, defaultSpec: specA() })
    fireDidFinishLoadAll()
    await initP

    expect(pool.getStats().total).toBe(2)

    await pool.dispose()
    await flush()

    expect(pool.getStats().total).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Adversarial-audit bugs A1/A2/A3/A5. These pin the hardened contract:
//   - A1: `releaseDestroyed` reclaims an in-use entry, and the
//     `win.once('closed', …)` reclaim hook removes a gracefully-closed pooled
//     window without refilling.
//   - A2: acquire guards ready entries with isDestroyed() so it never hands back
//     a destroyed pooled window; release disposes a destroyed window instead of
//     re-pooling it as ready.
//   - A3: reset()'s loadBlank swallows load failures — even when `loadURL`
//     throws synchronously — so release never rejects.
//   - A5: onGone must not destroy an in-use entry's window (the owner still
//     holds it); it only removes the entry.
// Mock-harness extensions used here:
//   - window-level `on`/`once` + `__winHandlers` registry on the BrowserWindow
//     stub, and a `fireClosed(win)` helper, so the A1 `'closed'` hook is testable.
// ─────────────────────────────────────────────────────────────────────────────
describe('ServiceHostPool — graceful-close leak (A1)', () => {
  // A1.1: releaseDestroyed removes an IN-USE entry without leaking, is a no-op on
  // unknown ids, and never throws. Intent: the owner can report an externally
  // dead acquired window and the pool reclaims the entry's slot.
  it('releaseDestroyed removes an in-use entry, is idempotent, and never throws', async () => {
    const pool = new ServiceHostPool()
    const initP = pool.init({ defaultPoolSize: 2, defaultSpec: specA() })
    fireDidFinishLoadAll()
    await initP

    let stats = pool.getStats()
    expect(stats.total).toBe(2)
    expect(stats.ready).toBe(2)

    const { entryId } = await pool.acquire(specA())
    expect(entryId).not.toBeNull()
    stats = pool.getStats()
    expect(stats.ready).toBe(1)
    expect(stats.inUse).toBe(1)
    expect(stats.total).toBe(2)

    // Typed shim for `releaseDestroyed`, which the public type does not expose;
    // this keeps the test compiling while calling the method on the impl.
    const releaseDestroyed = (id: string) =>
      (pool as unknown as { releaseDestroyed(entryId: string): void }).releaseDestroyed(id)

    // The owner's acquired window died externally → reclaim its slot.
    expect(() => releaseDestroyed(entryId as string)).not.toThrow()
    stats = pool.getStats()
    expect(stats.total).toBe(1) // entry gone, not leaked
    expect(stats.inUse).toBe(0)

    // Idempotent: calling again (now an unknown id) is a no-op, no throw.
    expect(() => releaseDestroyed(entryId as string)).not.toThrow()
    expect(() => releaseDestroyed('does-not-exist')).not.toThrow()
    expect(pool.getStats().total).toBe(1)
  })

  // A1.2: releaseDestroyed of an in-use entry must NOT spuriously refill. Intent:
  // an in-use death frees no pooled spare, so the target is already met by the
  // remaining ready entry — no new window should be constructed.
  it('releaseDestroyed of an in-use entry does not spuriously refill', async () => {
    const pool = new ServiceHostPool()
    const initP = pool.init({ defaultPoolSize: 2, defaultSpec: specA() })
    fireDidFinishLoadAll()
    await initP

    const { entryId } = await pool.acquire(specA())
    expect(entryId).not.toBeNull()

    const builtBefore = constructed.length
    // Typed shim (see A1.1): calls releaseDestroyed, which the public type omits.
    ;(pool as unknown as { releaseDestroyed(entryId: string): void }).releaseDestroyed(
      entryId as string,
    )
    await flush()

    // In-use death frees no pooled slot below target → no refill.
    expect(constructed.length).toBe(builtBefore)
  })

  // A1.3: the `win.once('closed', …)` reclaim hook removes a gracefully-closed
  // POOLED window WITHOUT refilling. Intent: a pooled window that dies by graceful
  // close must not leak its slot — but it must NOT trigger a refill either.
  //
  // Refill-on-graceful-close is wrong: pooled windows are hidden and only ever
  // close during app/project TEARDOWN, where `new BrowserWindow` (refill)
  // recreates windows while Electron is quitting and wedges shutdown. Crash
  // recovery (render-process-gone → onGone) still refills; graceful close only
  // reclaims bookkeeping. So this asserts reclaim-without-refill.
  it("the 'closed' hook reclaims a gracefully-closed pooled window without refilling", async () => {
    const pool = new ServiceHostPool()
    const initP = pool.init({ defaultPoolSize: 1, defaultSpec: specA() })
    fireDidFinishLoadAll()
    await initP

    expect(pool.getStats().ready).toBe(1)
    expect(constructed.length).toBe(1)

    const pooledWin = constructed[constructed.length - 1]!
    // The pool MUST have registered a window-level 'closed' reclaim hook.
    const closedHandlers = fireClosed(pooledWin)
    expect(closedHandlers).toBeGreaterThan(0)

    await flush()

    // Dead entry reclaimed; NO refill (would `new BrowserWindow` during teardown).
    expect(pool.getStats().ready).toBe(0)
    expect(pool.getStats().total).toBe(0)
    expect(constructed.length).toBe(1)
  })
})

describe('ServiceHostPool — never hand out / re-pool a destroyed window (A2)', () => {
  // A2.1: acquire must skip a destroyed ready entry and hand back a FRESH window
  // (entryId === null), removing the destroyed entry from the pool. Intent: a
  // pooled window that died while idle must never be served to a caller.
  it('acquire skips a destroyed ready entry and returns a fresh fallback', async () => {
    const pool = new ServiceHostPool()
    const initP = pool.init({ defaultPoolSize: 1, defaultSpec: specA() })
    fireDidFinishLoadAll()
    await initP

    expect(pool.getStats().ready).toBe(1)

    // Kill the warmed pooled window in place (match the harness mechanism:
    // isDestroyed() reads __destroyed; webContents.isDestroyed() reads .destroyed).
    const dead = constructed[0]!
    dead.__destroyed = true
    dead.webContents.destroyed = true
    expect((dead.isDestroyed as unknown as () => boolean)()).toBe(true)

    const r = await pool.acquire(specA())
    fireDidFinishLoadAll()

    // Must NOT hand back the destroyed pooled entry.
    expect(r.entryId).toBeNull()
    expect(r.win).toBeTruthy()
    expect(r.win).not.toBe(dead as any)
    // The destroyed entry is gone from the pool (not counted as ready).
    expect(pool.getStats().ready).toBe(0)
  })

  // A2.2: release of a destroyed window disposes it (does not re-pool) and
  // resolves without throwing. Intent: a window that died while in-use must not
  // come back as a ready pool entry.
  it('release of a destroyed window disposes it and resolves (does not re-pool)', async () => {
    const pool = new ServiceHostPool()
    const initP = pool.init({ defaultPoolSize: 2, defaultSpec: specA() })
    fireDidFinishLoadAll()
    await initP

    const { win, entryId } = await pool.acquire(specA())
    expect(entryId).not.toBeNull()

    const readyBefore = pool.getStats().ready // 1
    const totalBefore = pool.getStats().total // 2

    // The acquired window died mid-use.
    const w = win as unknown as StubWindow
    w.__destroyed = true
    w.webContents.destroyed = true

    const relP = pool.release(entryId, win as any)
    fireDidFinishLoadAll()
    await expect(relP).resolves.toBeUndefined()
    await flush()

    const stats = pool.getStats()
    // The destroyed entry must NOT return as ready, and must leave the pool.
    expect(stats.ready).toBe(readyBefore)
    expect(stats.total).toBe(totalBefore - 1)
  })
})

describe('ServiceHostPool — release never rejects on mid-flight load failure (A3)', () => {
  // A3: with clearStorageOnReset:false (reset early-returns after loadBlank) and a
  // window whose loadURL throws synchronously, release must still resolve. Intent:
  // a load/reset failure during release is swallowed, never propagated to callers.
  it('release resolves even when the window loadURL throws during reset', async () => {
    const spec = { ...specA(), clearStorageOnReset: false }
    const pool = new ServiceHostPool()
    const initP = pool.init({ defaultPoolSize: 1, defaultSpec: spec })
    fireDidFinishLoadAll()
    await initP

    const { win, entryId } = await pool.acquire(spec)
    expect(entryId).not.toBeNull()

    // Make this window's loadURL throw synchronously on the reset navigate.
    const w = win as unknown as StubWindow
    const loadURL = w.webContents.loadURL as unknown as {
      mockImplementationOnce(fn: () => unknown): void
    }
    loadURL.mockImplementationOnce(() => {
      throw new Error('boom: load failed mid-reset')
    })

    const relP = pool.release(entryId, win as any)
    fireDidFinishLoadAll()
    await expect(relP).resolves.toBeUndefined()
  })
})

describe('ServiceHostPool — render-process-gone on an in-use entry (A5)', () => {
  // A5: a crash of an IN-USE entry must remove the entry from the pool but must
  // NOT destroy the owner's window (the owner still holds it). Intent: the pool
  // only owns pooled windows; an in-use window belongs to the acquirer.
  it('in-use crash removes the entry but does not destroy the owner-held window', async () => {
    const pool = new ServiceHostPool()
    const initP = pool.init({ defaultPoolSize: 1, defaultSpec: specA() })
    fireDidFinishLoadAll()
    await initP

    const { win, entryId } = await pool.acquire(specA())
    expect(entryId).not.toBeNull()
    expect(pool.getStats().inUse).toBe(1)

    const ownerWin = win as unknown as StubWindow
    const handlerCount = fireRenderProcessGone(ownerWin)
    expect(handlerCount).toBeGreaterThan(0)
    await flush()

    // The entry is reclaimed from the pool…
    const stats = pool.getStats()
    expect(stats.inUse).toBe(0)
    expect(stats.total).toBe(0)
    // …but the pool must NOT have torn down the owner's window.
    expect(ownerWin.destroy.mock.calls.length).toBe(0)
    expect(ownerWin.close.mock.calls.length).toBe(0)
    expect(ownerWin.__destroyed).toBe(false)
  })
})
