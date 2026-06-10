/**
 * `Scope` — engine-agnostic nested-lifetime primitive, generalizing the
 * Connection/Disposable semantics in this package (foundation.md §4).
 *
 * A `Scope` owns a single "lifetime segment". Resources bound via `own()` and
 * sub-scopes created via `child()` are released together — both on `reset()`
 * (soft reuse: dispose the segment, open a fresh one, stay alive) and `close()`
 * (terminal: dispose everything, die). Teardown is LIFO and, crucially,
 * `reset()`/`close()` are COMPLETION FENCES: their Promise resolves (and the
 * `'reset'`/`'closed'` listeners fire) only AFTER the underlying async
 * disposeAll has fully finished — unlike `connection.ts`, which fires the
 * teardown and forgets (`void ...disposeAll()`).
 *
 * Cross-layer LIFO: a scope's teardown disposes its child sub-scopes (deepest
 * first, recursively) BEFORE its own directly-owned resources, so a grandchild
 * tears down before a child, which tears down before the root.
 */
import { DisposableRegistry, type Disposable, type DisposeFn } from './disposable.js'
import { createLogger } from './logger.js'

const log = createLogger('scope')

export interface Scope {
  readonly alive: boolean
  /** Bind a resource to the current lifetime segment; released by both reset()
   * and close() (LIFO). The returned Disposable releases it early (once). After
   * the scope is closed, the resource is disposed immediately (leak protection)
   * and a no-op handle is returned. */
  own(d: Disposable | (() => void)): Disposable
  /** Create a sub-scope bound to the current segment: a parent reset()/close()
   * cascades into it. A child close() does not affect the parent. */
  child(): Scope
  /** Soft reuse: await LIFO disposeAll of the current segment (children first,
   * then owned resources — async disposers truly complete), THEN open a fresh
   * segment and fire 'reset'. Scope stays alive. */
  reset(): Promise<void>
  /** Terminal: await LIFO disposeAll of the segment, mark dead, fire 'closed'
   * once. Idempotent. */
  close(): Promise<void>
  /** Subscribe to a lifecycle event; returns an unsubscribe Disposable. */
  on(event: 'reset' | 'closed', cb: () => void): Disposable
  /**
   * Re-parent `child` from THIS scope's current segment onto `newParent`'s
   * current segment WITHOUT resetting or closing it. The child's own()ed
   * resources stay live and neither 'reset' nor 'closed' fire on it; only the
   * cascade ownership moves (who tears it down from now on).
   *
   * If `this` or `newParent` has a teardown in flight, adopt WAITS for that
   * fence (it does not throw), then re-reads/re-validates against the fresh
   * segment. Validation failures (dead this/newParent, non-direct-child, cycle)
   * reject. On every path the child stays attached to EXACTLY one segment.
   */
  adopt(child: Scope, newParent: Scope): Promise<void>
}

/**
 * Internal view of a scope, exposing the structural hooks `adopt` needs to
 * reach across scope instances (current segment, parent pointer maintenance,
 * child-removal subscriptions). Not part of the public `Scope` contract.
 */
interface ScopeInternal extends Scope {
  /** The live segment (children/resources). Re-read after any fence wait. */
  __currentSegment(): Segment
  /** Whether a teardown is in flight, and a Promise to await it (the fence). */
  __inFlight(): Promise<void> | null
  /** This scope's current parent + the parent segment it is attached to. */
  __parent(): { parent: ScopeInternal | null; owningSegment: Segment | null }
  /** Attach `child` into `seg` as a tracked child, (re)binding the
   * on('closed') removal hook and recording it. Sets child's parent pointer. */
  __attachChild(child: ScopeInternal, seg: Segment): void
  /** Detach `child`: splice it from `seg.children`, dispose+drop its removal
   * hook, clear its parent pointer. */
  __detachChild(child: ScopeInternal, seg: Segment): void
  /** Set this scope's parent pointer (used when (re)attaching). */
  __setParent(parent: ScopeInternal | null, owningSegment: Segment | null): void
}

function asInternal(s: Scope): ScopeInternal {
  return s as ScopeInternal
}

/** True if `maybeAncestor` is `node` or an ancestor of it (walking parents). */
function isSelfOrAncestor(maybeAncestor: ScopeInternal, node: ScopeInternal): boolean {
  let cur: ScopeInternal | null = node
  while (cur) {
    if (cur === maybeAncestor) return true
    cur = cur.__parent().parent
  }
  return false
}

type LifecycleEvent = 'reset' | 'closed'

const NOOP_DISPOSABLE: Disposable = { dispose() {} }

function toDispose(d: Disposable | (() => void)): DisposeFn {
  return typeof d === 'function' ? d : () => d.dispose()
}

/**
 * Dispose a resource handed to a dead scope's `own()` — immediately, exactly
 * once, never delegating to a disposed segment (that would throw). Both sync
 * throws and async rejections are caught/logged so a late teardown can never
 * escape as an unhandledRejection in the main process.
 */
function disposeLate(d: Disposable | (() => void)): void {
  try {
    const r = toDispose(d)()
    if (r && typeof (r as Promise<void>).then === 'function') {
      ;(r as Promise<void>).catch((e) => log.error('late own() async disposer rejected', e))
    }
  } catch (e) {
    log.error('late own() resource disposer threw', e)
  }
}

/**
 * One lifetime segment: a set of child sub-scopes plus a `DisposableRegistry`
 * of directly-owned resources. Teardown disposes children first (deepest-first
 * cascade) then owned resources, both LIFO, awaiting each so async disposers
 * truly finish before the fence resolves.
 */
interface Segment {
  /** Insertion-ordered children created in this segment. */
  children: Scope[]
  resources: DisposableRegistry
}

function newSegment(): Segment {
  return { children: [], resources: new DisposableRegistry() }
}

async function disposeSegment(segment: Segment): Promise<void> {
  // Children first (LIFO), so a grandchild tears down before its child before
  // the parent's own resources. Each child.close() is itself a completion
  // fence, recursively awaiting its subtree.
  const children = segment.children.slice().reverse()
  segment.children = []
  for (const child of children) {
    try {
      await child.close()
    } catch (e) {
      log.error('child scope close threw during segment teardown', e)
    }
  }
  // Then the directly-owned resources (LIFO, async-aware via disposeAll).
  await segment.resources.disposeAll()
}

export function createScope(): Scope {
  let segment = newSegment()
  let alive = true

  // Single-flight teardown state. At most one teardown (reset OR close) runs at
  // a time; concurrent callers join the in-flight Promise instead of launching
  // a second, overlapping disposeAll. This is what makes a parent's
  // `await child.close()` a TRUE wait: a second close() on an already-closing
  // child returns that child's in-flight Promise (which resolves only after its
  // disposer truly finishes) rather than early-returning on the `alive` guard.
  //
  // `inFlight` is the Promise of the teardown currently running (null when
  // idle). `inFlightKind` distinguishes a soft reset (the scope stays alive, so
  // a later close must still run) from a terminal close (fully absorbs repeats).
  let inFlight: Promise<void> | null = null
  let inFlightKind: 'reset' | 'close' | null = null

  const resetListeners = new Set<() => void>()
  const closedListeners = new Set<() => void>()

  // This scope's place in the tree: its unique parent and the parent segment it
  // is attached to. Maintained by child()/adopt() (and the parent's removal hook
  // on this scope's close). Used by adopt() to validate direct-child membership,
  // detect cycles (walking parents), and re-home the child atomically.
  let parent: ScopeInternal | null = null
  let owningSegment: Segment | null = null

  // For each child this scope owns, the Disposable that unsubscribes the
  // on('closed') removal hook we bound when attaching it. child() previously
  // discarded this subscription (a leak); adopt() requires it so a re-parent can
  // unbind the stale hook. Keyed by child scope.
  const childRemovers = new Map<ScopeInternal, Disposable>()

  function emit(ev: LifecycleEvent): void {
    const set = ev === 'reset' ? resetListeners : closedListeners
    // Isolate faults so one throwing listener can't block the rest.
    for (const cb of [...set]) {
      try {
        cb()
      } catch (e) {
        log.error(`listener for "${ev}" threw`, e)
      }
    }
  }

  // Start a soft-reset teardown and register it as the in-flight single-flight
  // Promise. Swap in a fresh segment synchronously (so concurrent own()/child()
  // land in the new one), THEN await the old segment's full teardown before
  // firing 'reset'. The scope stays alive.
  function runReset(): Promise<void> {
    const old = segment
    segment = newSegment()
    inFlightKind = 'reset'
    const p = (async () => {
      // The disposer may throw (a disposeAll AggregateError); the error must
      // still reach the first caller, but the in-flight state MUST be cleared
      // and 'reset' fired regardless — otherwise the scope wedges permanently
      // (stale rejection forever, new segment leaked). finally guarantees both.
      try {
        await disposeSegment(old)
      } finally {
        // A concurrent close() may have upgraded this teardown to a terminal
        // close while we were awaiting; if so it owns clearing inFlight/emitting.
        if (inFlightKind === 'reset') {
          inFlight = null
          inFlightKind = null
          emit('reset')
        }
      }
    })()
    inFlight = p
    return p
  }

  // Start a terminal close teardown and register it as in-flight. Mark dead
  // synchronously so concurrent own() hits the leak-protection path, swap in a
  // fresh (poisoned) segment, then await the old segment's full teardown before
  // firing 'closed'.
  function runClose(): Promise<void> {
    alive = false
    const old = segment
    segment = newSegment()
    inFlightKind = 'close'
    const p = (async () => {
      // As in runReset: the disposer may throw (KA-5 lets a CommitError reach
      // the caller), but 'closed' must still fire and the in-flight state must
      // clear so a later close() is idempotent rather than a stale rejection.
      try {
        await disposeSegment(old)
      } finally {
        inFlight = null
        inFlightKind = null
        emit('closed')
      }
    })()
    inFlight = p
    return p
  }

  // Attach `child` into `seg` as a tracked child of THIS scope: push it onto the
  // segment, bind an on('closed') hook that splices it out (and drops its
  // remover) when the child dies, record that hook so adopt() can unbind it, and
  // set the child's parent pointer to this scope. Keeps the child in EXACTLY one
  // segment.
  function attachChild(child: ScopeInternal, seg: Segment): void {
    seg.children.push(child)
    const remover = child.on('closed', () => {
      const i = seg.children.indexOf(child)
      if (i >= 0) seg.children.splice(i, 1)
      childRemovers.delete(child)
    })
    childRemovers.set(child, remover)
    child.__setParent(scope as ScopeInternal, seg)
  }

  // Detach `child` from `seg`: splice it out, dispose+drop its removal hook, and
  // clear its parent pointer. Used by adopt() before re-homing it elsewhere.
  function detachChild(child: ScopeInternal, seg: Segment): void {
    const i = seg.children.indexOf(child)
    if (i >= 0) seg.children.splice(i, 1)
    const remover = childRemovers.get(child)
    if (remover) {
      remover.dispose()
      childRemovers.delete(child)
    }
    child.__setParent(null, null)
  }

  const scope: ScopeInternal = {
    get alive() {
      return alive
    },

    __currentSegment() {
      return segment
    },
    __inFlight() {
      return inFlight
    },
    __parent() {
      return { parent, owningSegment }
    },
    __attachChild(child, seg) {
      attachChild(child, seg)
    },
    __detachChild(child, seg) {
      detachChild(child, seg)
    },
    __setParent(p, seg) {
      parent = p
      owningSegment = seg
    },

    own(d) {
      // Leak protection: after close, do not delegate to the disposed segment
      // (that throws). Dispose the late resource immediately, return a no-op.
      if (!alive) {
        disposeLate(d)
        return NOOP_DISPOSABLE
      }
      return segment.resources.add(d)
    },

    child() {
      if (!alive) {
        // A child of a dead scope is born dead and pre-disposed.
        const dead = createScope()
        void dead.close()
        return dead
      }
      const sub = asInternal(createScope())
      // Bind the child to the current segment (tracked child + removal hook +
      // parent pointer). See attachChild.
      attachChild(sub, segment)
      return sub
    },

    reset() {
      if (!alive) return inFlight ?? Promise.resolve()
      // Single-flight: if a teardown is already running, join it. A reset in
      // flight already does what this call wants; a close in flight is terminal
      // (stronger) — either way the caller's intent (the current segment goes
      // away) is satisfied by awaiting the in-flight Promise.
      if (inFlight) return inFlight
      return runReset()
    },

    close() {
      // Single-flight + close-priority. close() must resolve only after the
      // scope's disposer has TRULY finished, so it never early-returns while a
      // teardown is mid-flight.
      if (!alive) {
        // Already dead. If a close is still completing, join it (true-wait);
        // otherwise the prior close fully finished — resolve immediately.
        return inFlight ?? Promise.resolve()
      }
      if (inFlight && inFlightKind === 'close') return inFlight
      if (inFlight && inFlightKind === 'reset') {
        // Upgrade an in-flight reset to a close. Mark dead now (terminal +
        // leak-protection: concurrent own() hits the disposeLate path). The
        // reset already swapped in a fresh `segment` and is tearing the old one
        // down; once it finishes we tear down that fresh segment too and fire
        // 'closed'. We chain rather than overlap so the two disposeAll passes
        // never run concurrently.
        alive = false
        const afterReset = inFlight
        inFlightKind = 'close'
        const upgraded = (async () => {
          // The in-flight reset may reject (a throwing disposer in the old
          // segment). Swallow that here — the upgrade still owns tearing down
          // the leftover (fresh) segment and firing 'closed'. The reset's own
          // rejection already reached its first caller.
          await afterReset.catch(() => {})
          const leftover = segment
          segment = newSegment()
          // Clear state + emit even if the leftover teardown throws, so a later
          // close() is idempotent rather than a permanent stale rejection.
          try {
            await disposeSegment(leftover)
          } finally {
            inFlight = null
            inFlightKind = null
            emit('closed')
          }
        })()
        inFlight = upgraded
        return upgraded
      }
      return runClose()
    },

    on(ev, cb) {
      const set = ev === 'reset' ? resetListeners : closedListeners
      set.add(cb)
      let removed = false
      return {
        dispose() {
          if (removed) return
          removed = true
          set.delete(cb)
        },
      }
    },

    async adopt(childPublic, newParentPublic) {
      const child = asInternal(childPublic)
      const newParent = asInternal(newParentPublic)
      const self = scope

      // ── Atomicity = WAIT not throw (codex #5) ──────────────────────────────
      // If either endpoint has a teardown in flight, park behind its fence
      // BEFORE reading any segment. We re-read segments AFTER waiting so we
      // attach to/detach from the fresh post-fence segment, never a stale one.
      // Loop because waiting on one fence may leave the other mid-flight (or a
      // new one may have started in the meantime).
      while (true) {
        const f = self.__inFlight() ?? newParent.__inFlight()
        if (!f) break
        // The fence resolves only after its disposeAll truly finishes; tolerate
        // rejection (we re-validate alive below regardless).
        await f.catch(() => {})
      }

      // ── Pre-validation (codex #4); failures reject, leaving child untouched ─
      if (!self.alive) {
        throw new Error('adopt: donor scope is not alive')
      }
      if (!newParent.alive) {
        throw new Error('adopt: newParent scope is not alive')
      }

      // Re-read the (post-fence) live segments.
      const fromSegment = self.__currentSegment()
      const toSegment = newParent.__currentSegment()

      // `child` must be a direct child of THIS scope's current segment.
      if (child.__parent().parent !== self || fromSegment.children.indexOf(child) < 0) {
        throw new Error('adopt: child is not a direct child of this scope current segment')
      }

      // No cycle: newParent must not be the child itself nor a descendant of it
      // (that would make the child contain itself). Walk newParent's ancestors.
      if (isSelfOrAncestor(child, newParent)) {
        throw new Error('adopt: would create a cycle (newParent is child or a descendant of it)')
      }

      // ── Atomic detach + re-attach (codex #2/#3/#6) ─────────────────────────
      // Splice out of the old segment + unbind the stale old-parent removal hook
      // (detachChild), then push into the new segment + bind a fresh removal hook
      // (newParent.__attachChild). The child is never in both lists and never in
      // neither — exactly one segment throughout. It is NOT reset/closed and its
      // own()ed resources are untouched, so 'reset'/'closed' never fire on it.
      self.__detachChild(child, fromSegment)
      newParent.__attachChild(child, toSegment)
    },
  }

  return scope
}
