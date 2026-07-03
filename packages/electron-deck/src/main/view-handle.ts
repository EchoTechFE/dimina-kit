/**
 * `ViewHandle` — the per-view orchestrator (view-handle.md「placeIn 与挂载」/「dispose（viewScope LIFO 序）」/「moveTo 跨窗迁移」). One handle
 * owns ONE native view and threads it through a window's z-planner. It composes
 * three INJECTED primitives and nothing else (no deck-app, no Electron):
 *   - a {@link NativeView} (its `ref` + a `setBounds` sink) — the native surface;
 *   - a {@link Scope} (`deps.scope`) — the view's home/native-view lifetime;
 *   - a {@link PlaceTarget} = `{ compositor, windowScope }` — a window's
 *     z-planner + lifetime, handed to {@link ViewHandle.placeIn}.
 *
 * Lifetime. `placeIn` adopts a `viewScope` that is a CHILD of the target
 * window's `windowScope`, so closing the windowScope cascades into the handle
 * (scope.ts cross-layer LIFO): the native view is detached and the placement
 * sink goes inert.
 *
 * handle 直接驱动 bounds. The handle drives `setBounds` DIRECTLY on its native view; the
 * Compositor stays a pure z-order planner (mount/unmount/commit only) and never
 * sees geometry.
 *
 * per-window teardown 顺序 (view-handle.md「dispose（viewScope LIFO 序）」). The viewScope owns the native detach
 * FIRST and the sink-disable LAST, so LIFO teardown runs the sink-disable
 * (STEP0) BEFORE the detach (STEP1): a late `place` frame can never drive a
 * native effect on a half-torn-down view.
 *
 * Cross-window move (view-handle.md「moveTo 跨窗迁移」/ compositor-and-teardown.md「moveTo 事务状态机」). {@link ViewHandle.moveTo}
 * migrates the view to another `{ compositor, windowScope }` as TWO independent
 * Compositor commits, guarded by a per-view async mutex (THE migrationLock —
 * each handle is one view). The current placement is a MUTABLE token so the
 * detach `own()` and `applyPlacement` always follow the CURRENT window after a
 * move. `rehome:true` re-parents the viewScope via {@link Scope.adopt} so
 * lifetime follows display; without it, lifetime stays under the src window.
 */
import type { Scope } from './scope.js'
import type { Compositor, NativeViewRef } from './compositor.js'

/** A screen-space rectangle, in CSS px. Mirrors `@dimina-kit/view-anchor`'s
 *  `Bounds` (electron-deck does not depend on view-anchor in this increment). */
export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Explicit visibility + geometry for a native view. Structurally identical to
 * the `@dimina-kit/view-anchor` `Placement` export; mirrored locally so this
 * increment adds no new package dependency.
 */
export type Placement = { visible: true; bounds: Bounds } | { visible: false }

/** The native surface a handle drives: its z-order identity (`ref`) plus the
 *  `setBounds` sink the handle calls directly (handle 直接驱动 bounds). `destroy` (optional)
 *  destroys the backing native view (its WebContents) — owned by the viewScope so
 *  it runs on teardown AFTER the detach (keepAlive「保活寿命归 Scope、淘汰策略归 host」lifetime/leak fix).
 *  Optional so fakes that don't model a native WebContents stay valid.
 *
 *  `webContents` / `capturePage` (optional) expose the backing native view's
 *  WebContents and a screenshot pass-through, so a handle accessor can recover
 *  them without re-deriving the WebContentsView from the window's content view.
 *  Optional so geometry-only fakes stay valid. */
export interface NativeView {
  readonly ref: NativeViewRef
  setBounds(b: Bounds): void
  destroy?(): void
  readonly webContents?: unknown
  capturePage?(): Promise<unknown>
}

/** A window's z-planner + lifetime, handed to {@link ViewHandle.placeIn}. The
 *  handle's per-placement teardown scope is a CHILD of `windowScope`. */
export interface PlaceTarget {
  compositor: Compositor
  windowScope: Scope
}

export interface ViewHandle {
  /** Mount the native view into the target window (mount + commit) and adopt a
   *  per-placement viewScope under the target's `windowScope`. Chainable. */
  placeIn(target: PlaceTarget, opts: { zone?: number }): ViewHandle
  /** The placement sink. Drops frames once disposed (idempotent late IPC).
   *  `visible:true` ensures mounted + drives `setBounds` directly; `visible:false`
   *  detaches (unmount + commit) but keeps the native view alive. */
  applyPlacement(p: Placement): void
  /**
   * Cross-window move (view-handle.md「moveTo 跨窗迁移」/ compositor-and-teardown.md「moveTo 事务状态机」). Migrate the view from its
   * current placement (`src`) to `dest` as TWO independent Compositor commits,
   * serialized by a per-view async mutex (migrationLock):
   *
   *     AT_SRC → DETACHED → AT_DEST                        (happy path)
   *            └→ (src.commit throws) → AT_SRC              (rethrow, no side effect)
   *     DETACHED → (dest.commit throws) → ROLLBACK → AT_SRC (rethrow dest error)
   *                                                └→ CLOSED (src re-mount ALSO throws)
   *
   * On success the compositor token moves to `dest` (later `applyPlacement`
   * drives the dest host). With `rehome:true`, the viewScope is re-parented under
   * dest's `windowScope` (lifetime follows display). moveTo 迁移显示而非寿命: moveTo moves DISPLAY
   * (and, with rehome, LIFETIME) — it does NOT carry capability grants; the dest
   * window's own control layer issues its own grant. Terminal (Promise<void>, not
   * chainable).
   */
  moveTo(dest: PlaceTarget, opts: { zone?: number; rehome?: boolean }): Promise<void>
  /** Tear down this placement: run the viewScope's A4 owns (sink-disable then
   *  native detach, via the LIFO completion fence). Idempotent. */
  dispose(): Promise<void>
  /** The backing native view's WebContents (pass-through from {@link NativeView}).
   *  Available immediately — the handle owns its view before any placeIn. */
  readonly webContents: unknown
  /** The view's LIVE screen-space rect when it is currently placed AND visible;
   *  `null` before the first placement, after `applyPlacement({visible:false})`,
   *  and after `dispose()`. Tracks the last applied `visible:true` bounds. */
  bounds(): Bounds | null
  /** Screenshot pass-through to the native view's `capturePage()`. */
  capturePage(): Promise<unknown>
}

export interface ViewHandleDeps {
  nativeView: NativeView
  scope: Scope
  /** Optional bookkeeping hook, fired whenever the viewScope tears down (window-
   *  close cascade OR explicit dispose). The deck-app uses it to drop the view
   *  from its keepAlive group — a window-close cascades the viewScope directly
   *  (NOT via the host wrapper's dispose), so group cleanup must hang off the
   *  scope to fire on that path too (KA-2). Any order — it is pure bookkeeping. */
  onDispose?(): void
}

export function createViewHandle(deps: ViewHandleDeps): ViewHandle {
  const { nativeView } = deps
  const ref = nativeView.ref

  // The CURRENT placement (mutable so a move re-points detach + applyPlacement at
  // the new window). `current` holds the live { compositor, windowScope }; the
  // viewScope's detach own() reads it at TEARDOWN time, so after a move it tears
  // down against whichever window the view now lives in.
  let current: { compositor: Compositor; windowScope: Scope } | null = null
  // The zone the view is currently placed/moved with — used to restore the src
  // intent on a move rollback (re-mount the view at its prior zone).
  let currentZone: number | undefined
  // The per-placement teardown scope (a child of the current target windowScope).
  let viewScope: Scope | null = null
  // The windowScope the viewScope is ACTUALLY parented under (its lifetime owner).
  // Distinct from `current.windowScope` (the display window): a display-only move
  // updates `current` but NOT `owning`, so a later `rehome:true` adopt uses the
  // viewScope's real parent as the donor (scope.adopt requires donor === parent).
  let owningWindowScope: Scope | null = null

  // The placement sink's gate. Goes false the instant the per-window teardown runs
  // (STEP0), so a late applyPlacement after dispose/cascade is a no-op.
  let active = false

  // The LIVE on-screen rect: the last `visible:true` bounds applied while the
  // view is active. Set on applyPlacement({visible:true}); cleared on
  // applyPlacement({visible:false}); read by bounds() (which also returns null
  // once the view is no longer active — never placed or disposed).
  let visibleBounds: Bounds | null = null

  // True WHILE a moveTo migration is in flight (the
  // migrationLock is held). `applyPlacement` drops place frames while migrating —
  // during the awaited dest commit + (rehome) adopt window, `current` already
  // points at dest but the SOURCE slot token may still be registered, so a stale
  // `place` from the source renderer could otherwise drive the view mid-migration
  // (setBounds against a half-migrated host). A place frame during a move is stale
  // by definition; drop it. Closes the window independent of token-revoke timing.
  let migrating = false

  // Per-view async mutex (THE migrationLock — a handle is one view). Serializes
  // moveTo calls FIFO: each runs only after the prior fully settles (success OR
  // failure), so the view is never being migrated from two places at once.
  let lockChain: Promise<unknown> = Promise.resolve()
  function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = lockChain.then(fn, fn)
    lockChain = run.then(
      () => {},
      () => {},
    )
    return run
  }

  function ensureMounted(): void {
    if (!current) return
    current.compositor.mount(ref, { zone: currentZone })
    current.compositor.commit()
  }

  // The actual teardown (viewScope.close A4 fence). Factored out so doMove's
  // CLOSED path can dispose WHILE it holds the migrationLock (calling the
  // lock-acquiring public `dispose()` from inside the lock would deadlock), and
  // the public `dispose()` can serialize itself behind the lock.
  async function doDispose(): Promise<void> {
    // Idempotent: a dispose before placeIn (or a second dispose) is a no-op.
    if (!viewScope) return
    await viewScope.close()
  }

  /**
   * Re-mount `ref` on `src` and commit. If that re-commit ALSO throws, the src
   * host is unrecoverable — close the view (viewScope.close ⇒ dispose) so it
   * doesn't stay homeless. Either way this always resolves (never rethrows);
   * the caller re-throws whatever ORIGINAL error triggered the rollback.
   */
  async function restoreSrcOrDispose(src: PlaceTarget, srcZone: number | undefined): Promise<void> {
    src.compositor.mount(ref, { zone: srcZone })
    try {
      src.compositor.commit()
    } catch {
      await doDispose()
    }
  }

  /**
   * Undo a landed dest commit (adopt failed AFTER the dest attach succeeded):
   * unmount + commit on dest to actually reverse the native attach (best-effort
   * — a failed detach commit leaves the host byte-for-byte and the planner
   * already dropped the intent), then restore src and point `current` back at
   * it BEFORE the src re-commit, so a CLOSED dispose tears down against the
   * right window.
   */
  async function rollbackDestAndRestoreSrc(dest: PlaceTarget, src: PlaceTarget, srcZone: number | undefined): Promise<void> {
    dest.compositor.unmount(ref.id)
    try {
      dest.compositor.commit()
    } catch {
      // best-effort — see doc-comment above.
    }
    src.compositor.mount(ref, { zone: srcZone })
    current = src
    currentZone = srcZone
    try {
      src.compositor.commit()
    } catch {
      await doDispose()
    }
  }

  async function doMove(
    dest: PlaceTarget,
    opts: { zone?: number; rehome?: boolean },
  ): Promise<void> {
    // Guard: can't move an unplaced/disposed view.
    if (!active || !current || !viewScope) {
      throw new Error('moveTo: the view is not currently placed (disposed or never placed)')
    }

    const src = current
    const srcZone = currentZone
    const destZone = opts.zone
    const vs = viewScope

    // ── STEP 1: detach from src (AT_SRC → DETACHED). ───────────────────────────
    src.compositor.unmount(ref.id)
    try {
      src.compositor.commit()
    } catch (e) {
      // src.commit threw → the view never left src (CommitError leaves the host
      // byte-for-byte pre-commit). Restore the src intent + re-commit so the
      // planner is consistent with the host again. Stays AT_SRC; rethrow.
      await restoreSrcOrDispose(src, srcZone)
      throw e
    }

    // ── STEP 2: attach to dest (DETACHED → AT_DEST). ───────────────────────────
    dest.compositor.mount(ref, { zone: destZone })
    try {
      dest.compositor.commit()
    } catch (destErr) {
      // dest.commit threw → ROLLBACK: re-mount on src so the view is never
      // dangling (I2). Drop the failed dest intent first.
      dest.compositor.unmount(ref.id)
      await restoreSrcOrDispose(src, srcZone)
      // Rolled back to AT_SRC (or CLOSED, if the restore also failed): rethrow
      // the dest error.
      throw destErr
    }

    // ── AT_DEST: native commit landed. The compositor token moves to dest. ─────
    current = { compositor: dest.compositor, windowScope: dest.windowScope }
    currentZone = destZone
    // rehome: re-parent the viewScope under dest's windowScope so dest-close
    // tears it down (lifetime follows display). Without rehome it stays under
    // src.windowScope (display moved, lifetime did not).
    //
    // adopt comes AFTER the native dest commit, so an
    // adopt failure must FULLY roll back the native dest commit + restore
    // `current`/`currentZone` to source — otherwise the view is detached from src
    // while compositor/`current` point at dest (native + lifetime diverge, and the
    // host catch would wrongly remove a dest child). moveTo's post-condition is
    // all-or-nothing: either dest + rehome both land, or we roll back to the
    // pre-move source state (same end-state as a dest-commit failure). Mirrors the
    // STEP-2 ROLLBACK arm exactly so the two failure paths converge.
    if (opts.rehome) {
      // The adopt donor MUST be the viewScope's ACTUAL parent (owningWindowScope),
      // not the current display window (src). After a display-only move, src is the
      // display window but the viewScope still lives under owningWindowScope, so
      // adopt(donor=src) would reject "child is not a direct child …".
      const donor = owningWindowScope ?? src.windowScope
      try {
        await donor.adopt(vs, dest.windowScope)
      } catch (adoptErr) {
        await rollbackDestAndRestoreSrc(dest, src, srcZone)
        // Rolled back to AT_SRC (or CLOSED, if the restore also failed):
        // rethrow the adopt error.
        throw adoptErr
      }
      // Adopt landed: the viewScope's lifetime now lives under dest's windowScope.
      owningWindowScope = dest.windowScope
    }
    // moveTo 迁移显示而非寿命: moveTo does NOT touch capability grants — the dest window's control
    // layer issues its own. Out of scope by construction.
  }

  const handle: ViewHandle = {
    placeIn(target, opts) {
      // One placeIn per handle: a SECOND placeIn must NOT silently overwrite
      // `current`/`viewScope` (the N3 corruption — the old viewScope would stay
      // alive under the old window and tear down the moved view on close). moveTo
      // is the ONLY migration path.
      if (viewScope) {
        throw new Error('ViewHandle.placeIn: view already placed — use moveTo() to migrate')
      }
      current = { compositor: target.compositor, windowScope: target.windowScope }
      currentZone = opts.zone

      // Appear in the host: mount + commit (against the current placement).
      ensureMounted()
      active = true

      // The handle's lifetime is a CHILD of the target window's scope, so the
      // windowScope's close() cascades into it.
      const vs = target.windowScope.child()
      viewScope = vs
      // The viewScope is born parented under the target window's scope.
      owningWindowScope = target.windowScope

      // A4 order: own the combined DETACH+DESTROY FIRST → LIFO runs it LAST, after
      // the sink-disable (STEP0). The sink-disable is owned LAST → LIFO runs it
      // FIRST. The detach reads `current` at teardown time (NOT a captured
      // compositor), so after a move it detaches from whichever window now hosts
      // the view. `destroy` is optional + idempotent (guarded by the caller).
      //
      // KA-5: detach and destroy are ONE disposer so destroy is reached only if
      // detach completes without throwing. Scope teardown runs disposers LIFO and
      // CONTINUES past a throwing one (disposable.ts) — so if these were separate
      // owns, a native commit() apply-failure on a LIVE host (compositor rollback
      // restores the attached snapshot) would still run a separate destroy own →
      // webContents.close() while the view is STILL attached to a live contentView
      // (dangling child). Combined, the throw propagates and the destroy line is
      // NOT reached: never destroy a WebContents while its view is still attached.
      // On an already-destroyed host the detach commit is the silent removals-only
      // path, so it doesn't throw and destroy runs correctly.
      vs.own(() => {
        if (current) {
          current.compositor.unmount(ref.id)
          current.compositor.commit()
        }
        deps.nativeView.destroy?.()
      })
      vs.own(() => {
        active = false
      })

      // Bookkeeping hook (KA-2): fires on ANY viewScope teardown — window-close
      // cascade OR explicit dispose. Order is irrelevant (it touches no native
      // state). The deck-app uses it to drop the view from its keepAlive group.
      vs.own(() => {
        deps.onDispose?.()
      })

      return handle
    },

    applyPlacement(p) {
      // Disposed / never-placed: drop the frame (idempotent late IPC).
      if (!active || !current) return
      // Drop place frames while a moveTo is in flight.
      // Mid-migration `current` may point at dest while the source token is still
      // live — a stale source `place` must NOT drive setBounds during the move.
      if (migrating) return
      if (p.visible) {
        // Set bounds BEFORE mounting so a fresh attach composites at its correct
        // geometry (avoids the attach-then-resize flicker the reconciler's op order
        // is built to prevent). setBounds on a not-yet-attached native view is
        // valid; when already mounted it's a plain resize and the mount is a no-op.
        // handle 直接驱动 bounds — bounds go straight to the native view, not the compositor.
        nativeView.setBounds(p.bounds)
        ensureMounted()
        // Track the live on-screen rect for bounds(). Copy so a later caller
        // mutation can't alter the recorded rect.
        visibleBounds = { x: p.bounds.x, y: p.bounds.y, width: p.bounds.width, height: p.bounds.height }
      } else {
        // Detach-but-keep: remove from the host, do NOT destroy the native view.
        current.compositor.unmount(ref.id)
        current.compositor.commit()
        // Not on screen → no live rect.
        visibleBounds = null
      }
    },

    moveTo(dest, opts) {
      // Terminal (Promise<void>, not chainable). Serialized by the per-view
      // migrationLock so two concurrent moves run FIFO (the view is never being
      // migrated from two hosts at once).
      //
      // Raise the `migrating` flag for the FULL duration
      // the lock holds this move (set/cleared inside the locked region so the flag
      // tracks exactly "a move is mid-flight"), so applyPlacement drops stale place
      // frames throughout the migration window — including the awaited adopt.
      return withLock(async () => {
        migrating = true
        try {
          return await doMove(dest, opts)
        } finally {
          migrating = false
        }
      })
    },

    dispose() {
      // Serialize dispose with the migrationLock so it
      // runs AFTER any in-flight moveTo fully settles (success OR rollback), not
      // concurrently — closing the viewScope independently would race a
      // move that is mid-migrating `current`/`viewScope` (e.g. the awaited adopt),
      // and a concurrent teardown could corrupt the move or double-tear-down. Routing
      // through `withLock` parks the dispose behind the move's lock segment; the
      // viewScope.close A4 fence (sink-disable then native detach) then runs once,
      // cleanly, on the settled post-move state. doMove's own CLOSED-path disposal
      // calls the un-locked `doDispose()` directly (it already holds the lock), so
      // there is no self-deadlock. doDispose is idempotent (no viewScope → no-op).
      return withLock(() => doDispose())
    },

    // ── Additive accessors (handle-level view recovery) ───────────────────────
    // The backing native view's WebContents, exposed immediately (the handle
    // owns its view before any placeIn).
    get webContents() {
      return nativeView.webContents
    },
    // The live screen-space rect: the last `visible:true` bounds applied while
    // the view is active. null before any placement, after `visible:false`, and
    // after dispose (active goes false on the viewScope's per-window teardown).
    bounds(): Bounds | null {
      if (!active || !visibleBounds) return null
      return { ...visibleBounds }
    },
    // Screenshot pass-through to the native view's webContents.capturePage().
    capturePage(): Promise<unknown> {
      if (!nativeView.capturePage) {
        return Promise.reject(new Error('ViewHandle.capturePage: native view has no capturePage'))
      }
      return nativeView.capturePage()
    },
  }

  return handle
}
