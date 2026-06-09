/**
 * `ViewHandle` — the per-view orchestrator (build-plan §2(a)/(b)/(d)). One handle
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
 * gap#1. The handle drives `setBounds` DIRECTLY on its native view; the
 * Compositor stays a pure z-order planner (mount/unmount/commit only) and never
 * sees geometry.
 *
 * A4 teardown order (build-plan §2(b)). The viewScope owns the native detach
 * FIRST and the sink-disable LAST, so LIFO teardown runs the sink-disable
 * (STEP0) BEFORE the detach (STEP1): a late `place` frame can never drive a
 * native effect on a half-torn-down view.
 *
 * Cross-window move (build-plan §2(d) / A1.3.2). {@link ViewHandle.moveTo}
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
 *  `setBounds` sink the handle calls directly (gap#1). `destroy` (optional)
 *  destroys the backing native view (its WebContents) — owned by the viewScope so
 *  it runs on teardown AFTER the detach (keepAlive B3.1 lifetime/leak fix).
 *  Optional so fakes that don't model a native WebContents stay valid. */
export interface NativeView {
  readonly ref: NativeViewRef
  setBounds(b: Bounds): void
  destroy?(): void
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
   * Cross-window move (build-plan §2(d) / A1.3.2). Migrate the view from its
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
   * dest's `windowScope` (lifetime follows display). gap#2: moveTo moves DISPLAY
   * (and, with rehome, LIFETIME) — it does NOT carry capability grants; the dest
   * window's own control layer issues its own grant. Terminal (Promise<void>, not
   * chainable).
   */
  moveTo(dest: PlaceTarget, opts: { zone?: number; rehome?: boolean }): Promise<void>
  /** Tear down this placement: run the viewScope's A4 owns (sink-disable then
   *  native detach, via the LIFO completion fence). Idempotent. */
  dispose(): Promise<void>
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

  // The placement sink's gate. Goes false the instant the A4 teardown runs
  // (STEP0), so a late applyPlacement after dispose/cascade is a no-op.
  let active = false

  // codex P0 round-3 (BUG 4): true WHILE a moveTo migration is in flight (the
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
  // the public `dispose()` can serialize itself behind the lock (BUG 5).
  async function doDispose(): Promise<void> {
    // Idempotent: a dispose before placeIn (or a second dispose) is a no-op.
    if (!viewScope) return
    await viewScope.close()
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
      src.compositor.mount(ref, { zone: srcZone })
      try {
        src.compositor.commit()
      } catch {
        // CLOSED: src is unrecoverable (the restore re-commit ALSO threw) → the
        // view is homeless. Close the view (viewScope.close ⇒ dispose) and
        // rethrow the original src error.
        await doDispose()
        throw e
      }
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
      src.compositor.mount(ref, { zone: srcZone })
      try {
        src.compositor.commit()
      } catch {
        // CLOSED: the rollback re-mount ALSO failed → the view is homeless.
        // Close the view (viewScope.close ⇒ dispose) and rethrow the dest error.
        await doDispose()
        throw destErr
      }
      // Rolled back to AT_SRC: `current` stays src; rethrow the dest error.
      throw destErr
    }

    // ── AT_DEST: native commit landed. The compositor token moves to dest. ─────
    current = { compositor: dest.compositor, windowScope: dest.windowScope }
    currentZone = destZone
    // rehome: re-parent the viewScope under dest's windowScope so dest-close
    // tears it down (lifetime follows display). Without rehome it stays under
    // src.windowScope (display moved, lifetime did not).
    //
    // codex P0 round-3 (BUG 3): adopt comes AFTER the native dest commit, so an
    // adopt failure must FULLY roll back the native dest commit + restore
    // `current`/`currentZone` to source — otherwise the view is detached from src
    // while compositor/`current` point at dest (native + lifetime diverge, and the
    // host catch would wrongly remove a dest child). moveTo's post-condition is
    // all-or-nothing: either dest + rehome both land, or we roll back to the
    // pre-move source state (same end-state as a dest-commit failure). Mirrors the
    // STEP-2 ROLLBACK arm exactly so the two failure paths converge.
    if (opts.rehome) {
      try {
        await src.windowScope.adopt(vs, dest.windowScope)
      } catch (adoptErr) {
        // Undo the SUCCESSFUL dest commit: unmount AND commit on dest so the
        // native dest attach is actually reversed (unlike the STEP-2 arm, here the
        // dest commit landed before adopt failed, so the leaked dest child must be
        // removed with a real dest commit — an unmount intent alone leaves it).
        dest.compositor.unmount(ref.id)
        try {
          dest.compositor.commit()
        } catch {
          // best-effort: a failed dest detach commit (CommitError) leaves the host
          // byte-for-byte; the planner already dropped the intent. Fall through to
          // the src re-mount regardless — the src restore is what matters for I2.
        }
        // Re-mount on src (back to AT_SRC).
        src.compositor.mount(ref, { zone: srcZone })
        // Restore the token BEFORE the re-commit so a CLOSED dispose tears down
        // against the right window, and a successful re-commit leaves `current`
        // pointing at src.
        current = src
        currentZone = srcZone
        try {
          src.compositor.commit()
        } catch {
          // CLOSED: the rollback re-mount ALSO failed → the view is homeless.
          await doDispose()
          throw adoptErr
        }
        // Rolled back to AT_SRC: rethrow the adopt error. The view is re-mounted
        // in src, `current` = src, and the (un-rehomed) viewScope is intact.
        throw adoptErr
      }
    }
    // gap#2: moveTo does NOT touch capability grants — the dest window's control
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
      // codex P0 round-3 (BUG 4): drop place frames while a moveTo is in flight.
      // Mid-migration `current` may point at dest while the source token is still
      // live — a stale source `place` must NOT drive setBounds during the move.
      if (migrating) return
      if (p.visible) {
        // Ensure attached (idempotent if still mounted; a fresh instance if it
        // was previously detached via visible:false), then drive bounds DIRECTLY
        // on the native view (gap#1 — not via the compositor).
        ensureMounted()
        nativeView.setBounds(p.bounds)
      } else {
        // Detach-but-keep: remove from the host, do NOT destroy the native view.
        current.compositor.unmount(ref.id)
        current.compositor.commit()
      }
    },

    moveTo(dest, opts) {
      // Terminal (Promise<void>, not chainable). Serialized by the per-view
      // migrationLock so two concurrent moves run FIFO (the view is never being
      // migrated from two hosts at once).
      //
      // codex P0 round-3 (BUG 4): raise the `migrating` flag for the FULL duration
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
      // codex P0 round-3 (BUG 5): serialize dispose with the migrationLock so it
      // runs AFTER any in-flight moveTo fully settles (success OR rollback), not
      // concurrently. `dispose` used to close the viewScope independently, racing a
      // move that is mid-migrating `current`/`viewScope` (e.g. the awaited adopt) —
      // a concurrent teardown could corrupt the move or double-tear-down. Routing
      // through `withLock` parks the dispose behind the move's lock segment; the
      // viewScope.close A4 fence (sink-disable then native detach) then runs once,
      // cleanly, on the settled post-move state. doMove's own CLOSED-path disposal
      // calls the un-locked `doDispose()` directly (it already holds the lock), so
      // there is no self-deadlock. doDispose is idempotent (no viewScope → no-op).
      return withLock(() => doDispose())
    },
  }

  return handle
}
