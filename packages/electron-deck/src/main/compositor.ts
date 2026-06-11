/**
 * `Compositor` — engine-agnostic z-order planner for a window's native child
 * views (foundation: the spikes in `.repro/electron-deck-spikes/`).
 *
 * It separates INTENT (mount / unmount / reorder a view into a zone, at a
 * relative position) from APPLICATION (`commit()` computes the minimal sequence
 * of host add/remove calls that transforms the host's current child order into
 * the target order).
 *
 * The host's observable z-semantics this planner is built on (from the spikes):
 *   - `addChildView` of an ALREADY-mounted child raises it to the top WITHOUT a
 *     remove first and WITHOUT reloading it.
 *   - `addChildView` of a NEW child appends it to the end (= topmost).
 *   - A batch of remove/add in ONE synchronous tick re-lands at the target order
 *     with zero renderer reloads.
 *   - `addChildView` into a destroyed contentView throws synchronously.
 *
 * Ordering model. Every mounted view carries `(zone, orderKey, viewId)`. The
 * total render order is that triple, ascending: lower zone renders BELOW higher
 * zone (zones stack), `orderKey` orders within a zone, and `viewId` is a pure
 * tiebreak so the order is deterministic even if two keys collide. `orderKey` is
 * a FRACTIONAL key: reorder-before(X) sets the moved view's key to the midpoint
 * between X's key and its in-zone predecessor's key, so a reorder is O(1) and
 * perturbs no other view's key. When repeated midpoints exhaust float precision
 * in a gap, the affected zone is RENUMBERED (rebalance) to evenly-spaced integer
 * keys — invisible, because the renumber preserves the existing relative order.
 *
 * mount epoch. A genuinely-new mount gets a fresh monotonically-increasing
 * `mountSeq` and lands at the top of its zone. Re-mounting a view that is STILL
 * mounted is a pure no-op (same orderKey/mountSeq, zero host churn). But an
 * `unmount(id)` followed by `mount(id)` is a NEW instance: it gets a new
 * mountSeq and lands at the top — it never resumes the old slot.
 *
 * commit. We fold the batch of intents into the FINAL target state (last-state,
 * not a write-log replay), then diff the host's current children against that
 * target. The longest increasing subsequence (LIS) of views already in correct
 * relative order — computed over the current∩target intersection — is left
 * untouched; every other shared view is `removeChildView` + `addChildView`, and
 * each brand-new view gets one explicit `addChildView`. All in one synchronous
 * pass. On failure `commit()` throws a typed {@link CommitError}: a destroyed
 * host with additions pending throws `host-destroyed` BEFORE touching native
 * (applied:false); a native call that throws mid-apply is caught and the host is
 * rolled back to its pre-apply snapshot, then `apply-failed` is thrown with
 * whether the rollback recovered the snapshot. A no-op commit, and a destroyed
 * host with only removals pending, are SILENT (teardown-friendly).
 */

/** A handle to a native child view. Identity is by `id`. */
export type NativeViewRef = { readonly id: string }

/**
 * Typed failure thrown by {@link Compositor.commit}. `kind` distinguishes a
 * preflight refusal (`host-destroyed`, native byte-for-byte pre-commit,
 * `applied:false`) from a mid-apply native throw (`apply-failed`,
 * `applied:'partial'`); for `apply-failed`, `recovered` reports whether the
 * best-effort rollback restored the pre-apply snapshot order (`false` ⇒ native
 * is untrusted and the host must be treated as dead).
 */
export class CommitError extends Error {
	readonly kind: 'host-destroyed' | 'apply-failed'
	readonly applied: false | 'partial'
	readonly recovered?: boolean
	constructor(args: {
		kind: 'host-destroyed' | 'apply-failed'
		applied: false | 'partial'
		recovered?: boolean
		message?: string
	}) {
		super(args.message ?? `commit failed: ${args.kind}`)
		this.name = 'CommitError'
		this.kind = args.kind
		this.applied = args.applied
		if (args.recovered !== undefined) this.recovered = args.recovered
	}
}

/**
 * The native content-view surface the Compositor drives. In production this is
 * an Electron `contentView` (`addChildView` / `removeChildView`); in tests it is
 * a faithful fake. `children()` returns the current order, LAST = topmost.
 */
export interface ContentViewHost {
  /** Already-mounted ref → raise to top (no remove, no reload); new ref →
   * append to the end (top). */
  addChildView(v: NativeViewRef): void
  removeChildView(v: NativeViewRef): void
  readonly isDestroyed: boolean
  /** Current child order; LAST element is the topmost. */
  children(): readonly NativeViewRef[]
}

export interface Compositor {
  /** Idempotent attach. A view STILL mounted → pure no-op (unchanged
   * orderKey/mountSeq, zero host calls). A new view (or one re-mounted after
   * unmount) → fresh mountSeq, lands at the top (end) of its zone. */
  mount(view: NativeViewRef, opts?: { zone?: number }): void
  /** Detach a view. A subsequent mount of the same id is a NEW instance. */
  unmount(viewId: string): void
  /** Move a view: `before` slots it immediately before that anchor (midpoint of
   * the anchor and its predecessor); `before: null` sends it to the end (top)
   * of the zone. `zone` moves it to a different zone. An illegal `before`
   * (unknown / unmounted id, or one whose zone conflicts with an explicit
   * `zone`) throws SYNCHRONOUSLY. */
  reorder(viewId: string, opts: { zone?: number; before?: string | null }): void
  /** Apply the folded target state to the host with the minimal add/remove
   * sequence (LIS-preserving). Returns void on success. Throws a typed
   * {@link CommitError} on failure: `kind:'host-destroyed'` (applied:false) when
   * the host is destroyed and there are ADDITIONS to apply — thrown BEFORE
   * touching native; `kind:'apply-failed'` (applied:'partial') when a native
   * call throws mid-apply, after a best-effort rollback to the pre-apply
   * snapshot (`recovered` flags whether the snapshot was restored). A no-op
   * commit, and a destroyed host with ONLY removals pending, are SILENT. */
  commit(): void
  /** Fold the intent state to EMPTY and commit, removing every native view
   * this window's compositor mounted from the host. The resulting commit is
   * REMOVALS-ONLY, so it reuses {@link commit}'s teardown-friendly
   * "destroyed host + only removals → silent" path (A1.2.1): on an
   * already-destroyed host it makes zero host calls and throws nothing.
   *
   * Optional on the interface so a partial test double (or a caller that only
   * needs mount/unmount/reorder/commit) still structurally satisfies
   * `Compositor`; the real {@link createCompositor} always implements it. */
  detachAll?(): void
}

interface MountedView {
  ref: NativeViewRef
  zone: number
  orderKey: number
  mountSeq: number
}

const DEFAULT_ZONE = 0

/**
 * Smallest representable gap between fractional keys before we renumber. Once a
 * midpoint would round to (or below) this distance from a neighbor, the zone is
 * rebalanced rather than risk key collision / loss of ordering.
 */
const MIN_KEY_GAP = 1e-9

export function createCompositor(host: ContentViewHost): Compositor {
  // Current intent state. This is the TARGET the next commit() will realize —
  // intents mutate it in place (last-state), so a commit always diffs the host's
  // real children against the latest fold.
  const views = new Map<string, MountedView>()
  let mountSeqCounter = 0

  /** Views in a zone, sorted by the in-zone order `(orderKey, viewId)`. */
  function zoneSorted(zone: number): MountedView[] {
    const out: MountedView[] = []
    for (const v of views.values()) if (v.zone === zone) out.push(v)
    out.sort(compareInZone)
    return out
  }

  function compareInZone(a: MountedView, b: MountedView): number {
    if (a.orderKey !== b.orderKey) return a.orderKey - b.orderKey
    return a.ref.id < b.ref.id ? -1 : a.ref.id > b.ref.id ? 1 : 0
  }

  /** Full target order: zones ascending (low renders first/bottom), then
   * in-zone order. */
  function targetOrder(): MountedView[] {
    const all = [...views.values()]
    all.sort((a, b) => {
      if (a.zone !== b.zone) return a.zone - b.zone
      return compareInZone(a, b)
    })
    return all
  }

  /** Next order key that lands a view at the TOP (end) of its zone. */
  function topKey(zone: number): number {
    const z = zoneSorted(zone)
    const last = z[z.length - 1]
    return last === undefined ? 0 : last.orderKey + 1
  }

  /**
   * Renumber a zone to evenly-spaced integer keys, preserving the current
   * relative order exactly. Invisible: the visible order is unchanged, so a
   * commit after a rebalance produces no extra host churn.
   */
  function rebalanceZone(zone: number): void {
    const z = zoneSorted(zone)
    z.forEach((v, i) => {
      v.orderKey = i
    })
  }

  /**
   * Compute the fractional key that places a view immediately before `anchor`
   * within its zone (the midpoint between `anchor` and its predecessor), or at
   * the zone top when `anchor` is null. If the midpoint would exhaust precision,
   * rebalance the zone and recompute on the fresh integer keys.
   */
  function keyBefore(zone: number, anchor: MountedView | null, movingId: string): number {
    if (anchor === null) return topKey(zone)

    const midpointBefore = (anchorId: string): number | null => {
      const z = zoneSorted(zone).filter((v) => v.ref.id !== movingId)
      const idx = z.findIndex((v) => v.ref.id === anchorId)
      const at = z[idx]
      // Anchor must still be present (caller validates), but guard defensively.
      if (idx < 0 || at === undefined) return null
      const hiKey = at.orderKey
      const prev = z[idx - 1]
      const loKey = prev !== undefined ? prev.orderKey : hiKey - 1
      const mid = (loKey + hiKey) / 2
      // Precision exhausted: the midpoint is indistinguishable from a neighbor.
      if (mid <= loKey + MIN_KEY_GAP || mid >= hiKey - MIN_KEY_GAP) return null
      return mid
    }

    const first = midpointBefore(anchor.ref.id)
    if (first === null && zoneSorted(zone).some((v) => v.ref.id === anchor.ref.id)) {
      // Precision exhausted in this gap: renumber the zone (invisible — relative
      // order preserved) and retry on the spaced-out integer keys.
      rebalanceZone(zone)
      const retry = midpointBefore(anchor.ref.id)
      if (retry !== null) return retry
    }
    return first ?? topKey(zone)
  }

  const compositor: Compositor = {
    mount(view, opts) {
      const zone = opts?.zone ?? DEFAULT_ZONE
      const existing = views.get(view.id)
      // Idempotent: a view that is STILL mounted is a pure no-op — keep its
      // orderKey/mountSeq, keep its ref, do not raise to top. (An unmount→mount
      // is a different code path: the map has no entry, so we fall through to a
      // fresh instance below.)
      if (existing) return

      views.set(view.id, {
        ref: view,
        zone,
        orderKey: topKey(zone),
        mountSeq: ++mountSeqCounter,
      })
    },

    unmount(viewId) {
      views.delete(viewId)
    },

    reorder(viewId, opts) {
      const mv = views.get(viewId)
      if (!mv) {
        throw new Error(`reorder: view "${viewId}" is not mounted`)
      }

      const before = opts.before
      const targetZone = opts.zone ?? mv.zone

      if (before === undefined || before === null) {
        // No anchor: send to the end (top) of the (possibly new) zone.
        mv.zone = targetZone
        mv.orderKey = topKey(targetZone)
        return
      }

      const anchor = views.get(before)
      if (!anchor) {
        throw new Error(`reorder: before anchor "${before}" is not mounted`)
      }
      // An explicit `zone` that disagrees with the anchor's zone is
      // contradictory — never silently pick one.
      if (opts.zone !== undefined && anchor.zone !== opts.zone) {
        throw new Error(
          `reorder: before anchor "${before}" is in zone ${anchor.zone}, ` +
            `which conflicts with the requested zone ${opts.zone}`,
        )
      }

      mv.zone = anchor.zone
      mv.orderKey = keyBefore(anchor.zone, anchor, viewId)
    },

    commit() {
      const target = targetOrder()
      const targetIds = target.map((v) => v.ref.id)
      const current = host.children().map((v) => v.id)

      const targetSet = new Set(targetIds)
      const currentSet = new Set(current)

      // Plan the host calls first, THEN check for emptiness, THEN check
      // isDestroyed — a no-op commit must neither throw nor touch the host.
      const removals: NativeViewRef[] = []
      const additions: { ref: NativeViewRef; atIndex: number }[] = []

      // The host can only `addChildView` to the TOP (append / raise). So a
      // commit keeps a set of views in place and piles the movers on top in
      // target order; for that to reproduce the target, the kept views must be
      // exactly the longest PREFIX of the target that is already an in-order
      // subsequence of the host's current children (i.e. the longest strictly
      // increasing prefix, by current position, of the shared views taken in
      // target order). Everything after that prefix — plus every brand-new view
      // — is a mover, re-added once in target order. This is the minimal host
      // churn: the LIS of the current∩target intersection that append-to-top can
      // leave untouched. (See compositor.test.ts §7.)
      const shared = targetIds.filter((id) => currentSet.has(id))
      const currentIndexOf = new Map<string, number>()
      current.forEach((id, i) => currentIndexOf.set(id, i))
      const keepIds = new Set<string>()
      let prevPos = -1
      for (const id of shared) {
        const pos = currentIndexOf.get(id)!
        if (pos > prevPos) {
          keepIds.add(id)
          prevPos = pos
        } else {
          break
        }
      }

      // Views the host currently has but the target drops → remove.
      for (const v of host.children()) {
        if (!targetSet.has(v.id)) removals.push(v)
      }
      // Shared views NOT in the kept prefix must be re-added in target order;
      // brand-new views (not currently mounted) get one explicit add. Walk the
      // target in order so additions carry their final index.
      target.forEach((v, i) => {
        const isNew = !currentSet.has(v.ref.id)
        const mustMove = currentSet.has(v.ref.id) && !keepIds.has(v.ref.id)
        if (isNew || mustMove) additions.push({ ref: v.ref, atIndex: i })
      })

      // no-op: nothing to apply → silent, never touches host (even if destroyed).
      if (removals.length === 0 && additions.length === 0) return

      if (host.isDestroyed) {
        // Teardown-friendly (A4.3): a destroyed host with ONLY removals is a
        // no-op — the views are already gone with the contentView, so there is
        // nothing to detach. Silently return (teardown commits must never throw).
        if (additions.length === 0) return
        // There are additions to apply to a destroyed host — impossible.
        // Preflight throw BEFORE touching the host: native is byte-for-byte
        // pre-commit.
        throw new CommitError({
          kind: 'host-destroyed',
          applied: false,
          message: 'commit: contentView is destroyed',
        })
      }

      // Apply phase. Snapshot the pre-apply native order so we can roll back if a
      // native call unexpectedly throws (host destroyed in the narrow plan→apply
      // window). One synchronous pass: removals first, then additions in target
      // order.
      const snapshot = host.children().slice()
      additions.sort((a, b) => a.atIndex - b.atIndex)
      try {
        for (const r of removals) host.removeChildView(r)
        for (const a of additions) host.addChildView(a.ref)
      } catch (applyErr) {
        // Best-effort rollback to snapshot: clear current children, re-add the
        // snapshot order. If rollback itself throws (host fully dying), native is
        // left untrusted (recovered:false) — the caller must treat this host as
        // dead.
        let recovered: boolean
        try {
          for (const v of host.children().slice()) host.removeChildView(v)
          for (const v of snapshot) host.addChildView(v)
          recovered = true
        } catch {
          recovered = false
        }
        throw new CommitError({
          kind: 'apply-failed',
          applied: 'partial',
          recovered,
          message: `commit apply failed: ${(applyErr as Error)?.message ?? applyErr}`,
        })
      }
    },

    detachAll() {
      // Fold the intent to EMPTY, then run the normal commit. With an empty
      // target the only pending work is removals, so on a destroyed host the
      // commit hits the teardown-friendly removals-only-on-destroyed path
      // (silent, zero host calls); on a live host it removes every child.
      for (const id of [...views.keys()]) views.delete(id)
      compositor.commit()
    },
  }

  return compositor
}
