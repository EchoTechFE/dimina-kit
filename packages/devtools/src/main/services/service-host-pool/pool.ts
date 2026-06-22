import { BrowserWindow } from 'electron'

/**
 * ServiceHostPool — main-process pre-warm pool for simulator host windows.
 *
 * Design source: `packages/devtools/docs/prewarm-webview.md`. WIRED into
 * native-host via `bridge-router.handleSpawn` (acquire) + `disposeAppSession`
 * (release / releaseDestroyed), opt-in behind `DIMINA_PREWARM_POOL_SIZE`
 * (default OFF). Only the SERVICE-HOST window is pooled; the simulator content
 * WebContentsView (`view-manager.attachNativeSimulator`) is created fresh per
 * attach. (A `<webview>`-tag arch is not poolable — Electron can't reparent a
 * pre-warmed WebContents into a `<webview>`.)
 *
 * Lifecycle of a pool entry:
 *   warming   — BrowserWindow constructed, page loading
 *   ready     — load settled; can be handed to a caller immediately
 *   in-use    — acquired by a caller (caller owns the window until release)
 *   resetting — released; navigated back to a blank page, then storage cleared
 *   disposing — being torn down; removed from the pool
 *
 * ── Phase-3 blockers, both RESOLVED in the wiring (kept here for context) ──
 * 1. Shared-session storage wipe — the service host shares the
 *    `persist:simulator` partition with live projects, so clearing it on reset
 *    would wipe other projects. Resolved by `ServiceHostSpec.clearStorageOnReset`:
 *    `serviceHostSpec()` sets it `false`, so reset only navigates the
 *    window to blank (resetting the JS realm) and never clears the shared
 *    session; cross-spawn isolation rides on appId-namespacing + fresh nav,
 *    matching the already-shared simulator `<webview>` behavior.
 * 2. Warming vs preload contract — warming loads `about:blank` (no bridgeId).
 *    `src/service-host/preload.cjs` now idles (early `return`) when `bridgeId`
 *    is absent instead of throwing, so a warmed window survives until the real
 *    spawn navigation re-runs the preload with a bridgeId.
 *
 * ── Window-death observation ───────────────────────────────────────────────
 * A pooled/in-use window can die three ways: a render crash
 * (`render-process-gone`), a graceful close (`'closed'`), or the owner closing
 * an acquired window (reported via `releaseDestroyed`). All three funnel through
 * `reclaim()`: a POOLED death frees a spare → refill toward target; an IN-USE
 * death is the owner's window → drop the bookkeeping WITHOUT destroying it from
 * under them, and do not refill (the spare count is unaffected).
 */

/** Entry state machine (see class doc). */
export type EntryState = 'warming' | 'ready' | 'in-use' | 'resetting' | 'disposing'

/**
 * A spec fully determines whether a warm window can serve a caller. Reuse is
 * keyed on `preloadPath`: a different preload means a different runtime surface,
 * so the pool will not hand a mismatched entry to a caller.
 *
 * The process-model flags (`contextIsolation` / `sandbox` / `nodeIntegration`)
 * default to the simulator service-host contract (all `false`, mirroring
 * `createServiceHostWindow`) so a warmed window is a faithful stand-in for the
 * window the caller will actually use. They are part of the spec — not
 * hardcoded — so a caller with a different runtime can override them.
 */
export interface ServiceHostSpec {
  /** Session partition for the window. Opaque to the pool (see KNOWN BLOCKER 1). */
  partition: string
  /** Absolute path to the preload bundle. The reuse key. */
  preloadPath: string
  /** Initial window size (affects first layout). */
  size?: { width: number; height: number }
  /** Open DevTools on the window (dev only). */
  devTools?: boolean
  /** webPreferences.contextIsolation. Default false (service-host contract). */
  contextIsolation?: boolean
  /** webPreferences.sandbox. Default false (service-host contract). */
  sandbox?: boolean
  /** webPreferences.nodeIntegration. Default false (service-host contract). */
  nodeIntegration?: boolean
  /**
   * Whether `release` clears this window's session storage. Default `true`.
   * Set `false` when the window shares a session with live consumers (e.g. the
   * service host on the shared `persist:simulator` partition) — clearing there
   * would wipe other projects' storage. With `false`, reset still navigates the
   * window to a blank page (tearing down the old JS realm); cross-spawn state is
   * handled by appId-namespacing + the fresh navigation, matching the
   * already-shared, never-cleared simulator `<webview>` behavior.
   */
  clearStorageOnReset?: boolean
}

/** Snapshot of pool occupancy, for dev panels / IPC `prewarm:status`. */
export interface ServiceHostPoolStats {
  total: number
  ready: number
  inUse: number
  warming: number
  resetting: number
  spec: ServiceHostSpec | null
}

export interface ServiceHostPoolInitOptions {
  /** Number of entries to keep warm. Default target after init. */
  defaultPoolSize: number
  /** Spec used to warm the initial entries. */
  defaultSpec: ServiceHostSpec
  /** Hard ceiling on pooled entries. Clamped to ≤ 4 (doc §3.3). Default 3. */
  maxPoolSize?: number
}

interface PoolEntry {
  id: string
  spec: ServiceHostSpec
  state: EntryState
  win: BrowserWindow
  /** Resolves when warming → ready completes (or the entry is torn down). */
  ready: Promise<void>
}

/** Blank placeholder URL loaded while warming / after reset. */
const BLANK_URL = 'about:blank'

/** Hard ceiling on pool size regardless of requested size (doc §3.3). */
const HARD_MAX_POOL_SIZE = 4

/** Storage buckets cleared on every release (doc §3.4 "必须" rows). */
const RESET_STORAGES = [
  'cookies',
  'localstorage',
  'indexdb',
  'serviceworkers',
  'cachestorage',
] as const

export class ServiceHostPool {
  private readonly entries = new Map<string, PoolEntry>()
  private currentSpec: ServiceHostSpec | null = null
  private targetSize = 0
  private maxPoolSize = 3
  private nextId = 0
  private disposed = false

  /**
   * Warm `defaultPoolSize` entries with `defaultSpec`. Normally resolves once the
   * pool has reached `defaultPoolSize` ready entries — even if a warming window
   * crashes mid-init and is refilled. NOTE: `warmUpToTarget` caps its refill loop
   * with a bounded guard, so under SUSTAINED warm crashes `init` resolves
   * best-effort (possibly under-filled) rather than spinning forever — treat
   * `getStats().ready` as advisory after init, not a hard invariant.
   */
  async init(opts: ServiceHostPoolInitOptions): Promise<void> {
    if (this.disposed) return
    this.currentSpec = opts.defaultSpec
    this.maxPoolSize = Math.min(opts.maxPoolSize ?? 3, HARD_MAX_POOL_SIZE)
    this.targetSize = Math.min(Math.max(opts.defaultPoolSize, 0), this.maxPoolSize)
    await this.warmUpToTarget()
  }

  /**
   * Hand a ready window matching `spec` to the caller. If none is ready, fall
   * back to synchronously constructing a fresh window — never blocking on warm
   * (doc §3.1 "绝不阻塞 acquire"). Fallback windows carry `entryId === null` and
   * are destroyed (not pooled) on release.
   *
   * A spec change (different `preloadPath`) tears down all *pooled* entries and
   * re-targets the pool to the new spec; in-use entries are left to their owners
   * and disposed when returned (see `release`).
   */
  async acquire(spec: ServiceHostSpec): Promise<{ win: BrowserWindow; entryId: string | null }> {
    if (this.currentSpec && this.currentSpec.preloadPath !== spec.preloadPath) {
      this.onSpecChange(spec)
    } else if (!this.currentSpec) {
      this.currentSpec = spec
    }

    for (const entry of this.entries.values()) {
      if (entry.state === 'ready' && this.matches(entry.spec, spec)) {
        // A ready entry whose window died (closed/crashed) while idle must never
        // be handed out — navigating a destroyed WebContents silently no-ops the
        // spawn. Drop it (and refill) and keep scanning.
        if (entry.win.isDestroyed()) {
          this.reclaim(entry, { destroyIfPooled: false, refill: false })
          continue
        }
        entry.state = 'in-use'
        return { win: entry.win, entryId: entry.id }
      }
    }

    // Pool miss → fallback create. Not pooled; entryId null.
    const win = this.createWindow(spec)
    // Kick the load but do not await — acquire must not block.
    void this.loadBlank(win)
    return { win, entryId: null }
  }

  /**
   * Return a window. Fallback windows (`entryId === null`) and entries whose
   * spec no longer matches the current pool spec are torn down. Otherwise the
   * window is reset (navigated to blank, then storage cleared) and re-pooled as
   * `ready`, unless that would exceed `maxPoolSize`.
   */
  async release(entryId: string | null, win: BrowserWindow): Promise<void> {
    if (entryId === null) {
      this.destroyWindow(win)
      return
    }
    const entry = this.entries.get(entryId)
    if (!entry) {
      this.destroyWindow(win)
      return
    }
    if (this.disposed || !this.currentSpec || !this.matches(entry.spec, this.currentSpec)) {
      this.disposeEntry(entry)
      return
    }

    entry.state = 'resetting'
    await this.reset(entry)

    // The entry may have been disposed/crashed/spec-changed/destroyed underneath
    // the reset await; only re-pool if it is still the live, resetting entry with
    // a live window. A destroyed window must never be re-marked `ready` (a later
    // acquire would hand it out and the spawn would silently never boot).
    if (
      this.disposed
      || this.entries.get(entryId) !== entry
      || entry.state !== 'resetting'
      || entry.win.isDestroyed()
    ) {
      this.destroyWindow(entry.win)
      this.entries.delete(entryId)
      return
    }
    // Honor the hard cap: if re-pooling would exceed maxPoolSize, drop it.
    const otherPooled = this.warmCount() - (this.isWarm(entry) ? 1 : 0)
    if (otherPooled >= this.maxPoolSize) {
      this.disposeEntry(entry)
      return
    }
    entry.state = 'ready'
  }

  /**
   * The owner of an acquired window reports it died externally (graceful close /
   * crash) — reclaim its in-use slot so it isn't leaked in `entries` forever
   * (bridge-router calls this on the `serviceAlreadyClosed` teardown path, where
   * `release` is intentionally skipped). No-op for an unknown id; idempotent;
   * never touches the (already-gone) window.
   */
  releaseDestroyed(entryId: string | null): void {
    if (entryId === null) return
    const entry = this.entries.get(entryId)
    if (!entry) return
    this.reclaim(entry, { destroyIfPooled: false, refill: false })
  }

  /**
   * Re-target the pool. `target` is clamped to `[0, maxPoolSize]`. Pooled
   * entries beyond the target are disposed OLDEST-FIRST (doc §3.3/§3.6); in-use
   * entries are untouched. Does not warm new entries up (use `init` / refill).
   */
  resize(target: number): void {
    this.targetSize = Math.min(Math.max(target, 0), this.maxPoolSize)
    // Map iteration is insertion order, so `pooled` is oldest-first. Dispose the
    // oldest prefix and keep the `targetSize` most-recently-created entries.
    const pooled = [...this.entries.values()].filter((e) => this.isWarm(e))
    const surplus = pooled.length - this.targetSize
    if (surplus <= 0) return
    for (const entry of pooled.slice(0, surplus)) {
      this.disposeEntry(entry)
    }
  }

  /** Occupancy snapshot. */
  getStats(): ServiceHostPoolStats {
    let ready = 0
    let inUse = 0
    let warming = 0
    let resetting = 0
    for (const entry of this.entries.values()) {
      switch (entry.state) {
        case 'ready':
          ready++
          break
        case 'in-use':
          inUse++
          break
        case 'warming':
          warming++
          break
        case 'resetting':
          resetting++
          break
      }
    }
    return { total: this.entries.size, ready, inUse, warming, resetting, spec: this.currentSpec }
  }

  /** Tear down every entry and stop accepting work. */
  async dispose(): Promise<void> {
    this.disposed = true
    this.targetSize = 0
    for (const entry of [...this.entries.values()]) {
      this.disposeEntry(entry)
    }
  }

  // ── internals ──────────────────────────────────────────────────────────

  private matches(a: ServiceHostSpec, b: ServiceHostSpec): boolean {
    return a.preloadPath === b.preloadPath
  }

  /** ready + warming + resetting entries are "pooled" (owned by the pool). */
  private isWarm(entry: PoolEntry): boolean {
    return entry.state === 'ready' || entry.state === 'warming' || entry.state === 'resetting'
  }

  private warmCount(): number {
    let n = 0
    for (const entry of this.entries.values()) {
      if (this.isWarm(entry)) n++
    }
    return n
  }

  private readyCount(): number {
    let n = 0
    for (const entry of this.entries.values()) {
      if (entry.state === 'ready') n++
    }
    return n
  }

  /**
   * Drive the pool to `targetSize` ready entries and resolve only then. Loops so
   * a crash that drops a warming entry mid-init (which refills asynchronously
   * via `onGone`) is awaited too, instead of resolving on a stale snapshot. A
   * generous iteration guard prevents an unbounded spin if windows keep dying.
   */
  private async warmUpToTarget(): Promise<void> {
    if (!this.currentSpec) return
    let guard = 0
    const maxIterations = this.targetSize * 8 + 8
    while (!this.disposed && this.readyCount() < this.targetSize && guard++ < maxIterations) {
      while (this.warmCount() < this.targetSize) {
        void this.warmOne(this.currentSpec)
      }
      const warming = [...this.entries.values()]
        .filter((e) => e.state === 'warming')
        .map((e) => e.ready)
      if (warming.length === 0) break
      await Promise.all(warming)
    }
  }

  private createWindow(spec: ServiceHostSpec): BrowserWindow {
    return new BrowserWindow({
      show: false,
      width: spec.size?.width,
      height: spec.size?.height,
      webPreferences: {
        preload: spec.preloadPath,
        partition: spec.partition,
        // Mirror createServiceHostWindow's process model (create.ts:24-30): the
        // service-host preload does `require('electron')` and writes globals
        // onto the page realm, so it requires nodeIntegration:false,
        // contextIsolation:false, sandbox:false. Default to that contract; let a
        // caller override via the spec for a different runtime.
        nodeIntegration: spec.nodeIntegration ?? false,
        contextIsolation: spec.contextIsolation ?? false,
        sandbox: spec.sandbox ?? false,
      },
    })
  }

  private loadBlank(win: BrowserWindow): Promise<void> {
    // `loadURL` resolves on did-finish-load in Electron; treat any failure as a
    // settled load so a single bad warm never wedges the pool. The synchronous
    // call ITSELF throws on an already-destroyed webContents (it isn't a
    // rejection) — swallow that too, so reset/release of a window that died
    // mid-flight resolves instead of rejecting (the "never wedges" contract).
    try {
      return Promise.resolve(win.webContents.loadURL(BLANK_URL)).then(
        () => undefined,
        () => undefined,
      )
    } catch {
      return Promise.resolve()
    }
  }

  /** Construct + load a fresh pooled entry, registering crash recovery. */
  private warmOne(spec: ServiceHostSpec): Promise<void> {
    const win = this.createWindow(spec)
    const id = `pool-${++this.nextId}`
    const entry: PoolEntry = { id, spec, state: 'warming', win, ready: Promise.resolve() }
    this.entries.set(id, entry)
    win.webContents.on('render-process-gone', () => this.onGone(entry))
    // A window can also die by graceful close (app quit / manual close), which
    // never fires render-process-gone. Observe it too so a pooled entry isn't
    // leaked. reclaim is a no-op if WE disposed it (disposeEntry deletes the
    // entry before its own destroy fires 'closed').
    win.once('closed', () => this.reclaim(entry, { destroyIfPooled: false, refill: false }))

    entry.ready = this.loadBlank(win).then(() => {
      if (entry.state === 'warming') entry.state = 'ready'
    })
    return entry.ready
  }

  /**
   * Reset a released window back to a clean, blank state. Order matters
   * (doc §3.5.3 / §3.4「等待时序」): navigate to blank FIRST so the old document
   * stops running and in-flight requests are aborted, THEN clear storage — so a
   * still-live old page cannot re-populate storage after the clear.
   */
  private async reset(entry: PoolEntry): Promise<void> {
    await this.loadBlank(entry.win)
    // Consumers sharing a session opt out of the storage clear (see
    // ServiceHostSpec.clearStorageOnReset): clearing a shared partition would wipe
    // other live projects. Navigation-to-blank above still resets the JS realm.
    if (entry.spec.clearStorageOnReset === false) return
    // The window may have been destroyed during the load await; touching a dead
    // webContents.session throws SYNCHRONOUSLY, which would reject release().
    if (entry.win.isDestroyed()) return
    try {
      const ses = entry.win.webContents.session
      await ses.clearStorageData({ storages: [...RESET_STORAGES] })
      await ses.clearCache()
    } catch {
      // Window/session torn down mid-reset — release() re-checks isDestroyed and
      // disposes the entry, so swallowing here keeps release from rejecting.
    }
  }

  /** A spec change tears down pooled entries and re-targets the pool. */
  private onSpecChange(spec: ServiceHostSpec): void {
    for (const entry of [...this.entries.values()]) {
      if (this.isWarm(entry)) this.disposeEntry(entry)
    }
    this.currentSpec = spec
  }

  /**
   * Reclaim an entry whose window died externally (render crash, graceful close,
   * or an owner-reported destruction). A POOLED death frees a spare → refill
   * toward target; an IN-USE death is the caller's window → drop the bookkeeping
   * WITHOUT destroying it from under them, and do not refill (the spare count is
   * unaffected). `destroyIfPooled` destroys the husk for a pooled render crash
   * (the BrowserWindow object can outlive a dead render process); skip it for a
   * `'closed'`/owner-reported window that is already gone. No-op if the entry was
   * already disposed by us (disposeEntry deletes before its own destroy fires
   * `'closed'`, so this finds nothing).
   */
  private reclaim(entry: PoolEntry, opts: { destroyIfPooled: boolean; refill: boolean }): void {
    if (!this.entries.has(entry.id)) return
    const wasPooled = this.isWarm(entry)
    entry.state = 'disposing'
    this.entries.delete(entry.id)
    if (wasPooled && opts.destroyIfPooled) this.destroyWindow(entry.win)
    // Refill ONLY on crash recovery (onGone). A graceful `'closed'` on a pooled
    // window happens exclusively at app/project teardown (the windows are hidden;
    // nothing else closes them) — refilling there would `new BrowserWindow` while
    // Electron is trying to quit, recreating windows faster than they close and
    // hanging the shutdown. So `refill` is opt-in per caller.
    if (!opts.refill || this.disposed || !this.currentSpec || !wasPooled) return
    while (this.warmCount() < this.targetSize) {
      void this.warmOne(this.currentSpec)
    }
  }

  /** A pooled window's render process died — reclaim + refill (destroy the husk). */
  private onGone(entry: PoolEntry): void {
    this.reclaim(entry, { destroyIfPooled: true, refill: true })
  }

  private disposeEntry(entry: PoolEntry): void {
    entry.state = 'disposing'
    this.entries.delete(entry.id)
    this.destroyWindow(entry.win)
  }

  private destroyWindow(win: BrowserWindow): void {
    try {
      if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return
      if (typeof win.destroy === 'function') win.destroy()
      else if (typeof win.close === 'function') win.close()
    } catch {
      // A window already gone (e.g. crashed process) is fine to ignore.
    }
  }
}
