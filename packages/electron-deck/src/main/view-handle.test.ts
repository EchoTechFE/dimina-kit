/**
 * Behavior tests for `ViewHandle` — the per-view orchestrator (keystone) —
 * the `createViewHandle()` contract implemented in `./view-handle.js`.
 *
 * For THIS unit increment (view-handle.md「placeIn 与挂载」/「dispose（viewScope LIFO 序）」), a `ViewHandle` composes three
 * INJECTED primitives and nothing else (no deck-app, no Electron):
 *   - a `NativeView` (its `ref` + a `setBounds` sink) — the native surface;
 *   - a `Scope` — the handle's own lifetime, a CHILD of the target window scope;
 *   - a `PlaceTarget` = { compositor, windowScope } — a window's z-planner +
 *     lifetime, handed to `placeIn`.
 *
 * The behaviors pinned here (compose against the REAL `createScope()` and REAL
 * `createCompositor(fakeHost)`; the `NativeView` is faked with a `setBounds`
 * spy):
 *   1. placeIn mounts + commits (host gains the view) and returns the handle.
 *   2. placeIn creates a viewScope UNDER the target windowScope (closing the
 *      windowScope disposes the handle: a later applyPlacement is a no-op AND
 *      the view was detached).
 *   3. applyPlacement(visible:true, bounds) → nativeView.setBounds(bounds)
 *      (handle drives bounds: the handle drives bounds DIRECTLY, not via the compositor).
 *   4. applyPlacement(visible:false) → compositor.unmount + commit (detach but
 *      keep the native view alive); a later visible:true re-mounts + setBounds.
 *   5. dispose() = viewScope.close in A4 order: sink-disable (STEP0) runs BEFORE
 *      the native detach (STEP1) — handle owns detach FIRST so LIFO runs the
 *      sink-disable first, then detach (view-handle.md「dispose（viewScope LIFO 序）」).
 *   6. a late applyPlacement AFTER dispose is a NO-OP (idempotent late IPC: the
 *      sink must drop a place frame that arrives post-teardown).
 *   7. detach during dispose is silent on a destroyed host (the removals-only
 *      teardown-friendly commit path; no throw).
 *
 * `Placement` is mirrored locally (structurally identical to the
 * `@dimina-kit/view-anchor` export) — the same local-mirror pattern
 * `compositor.test.ts` uses for `NativeViewRef`/`ContentViewHost`, so a missing
 * `./view-handle.js` export fails locally, not as an unrelated package resolution.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { createScope, type Scope } from './scope.js'
import { createCompositor, CommitError, type Compositor, type NativeViewRef } from './compositor.js'

// ── Mirrored Placement (== @dimina-kit/view-anchor `Placement`) ──────────────
type Bounds = { x: number; y: number; width: number; height: number }
type Placement = { visible: true; bounds: Bounds } | { visible: false }

// ── Public contract of the unit under test (mirrored locally) ────────────────
interface NativeView {
  readonly ref: { id: string }
  setBounds(b: Bounds): void
  // Optional (KA-5 pin): the deck-app injects webContents.close() here so the
  // viewScope can DESTROY the backing native view on teardown (after a clean
  // detach). Fakes that don't model a WebContents omit it.
  destroy?(): void
}
interface PlaceTarget {
  compositor: Compositor
  windowScope: Scope
}
interface ViewHandle {
  placeIn(target: PlaceTarget, opts: { zone?: number }): ViewHandle
  applyPlacement(p: Placement): void
  // view-handle.md「moveTo 跨窗迁移」/ compositor-and-teardown.md「moveTo 事务状态机」:
  // cross-window move, two independent Compositor
  // commits guarded by a per-view migrationLock. Terminal (Promise<void>, not
  // chainable). `rehome:true` re-parents the viewScope via Scope.adopt.
  // moveTo 迁移显示而非寿命 RESOLUTION (pinned in the tests below): moveTo moves DISPLAY (and,
  // only with rehome:true, LIFETIME) — it does NOT carry capability grants.
  moveTo(
    dest: PlaceTarget,
    opts: { zone?: number; rehome?: boolean },
  ): Promise<void>
  dispose(): Promise<void>
}

// Loaded dynamically in `beforeAll` so a broken/missing export turns these specs
// red at test time (a resolve/runtime failure) rather than a hard compile error
// that would prevent the whole suite from running.
let createViewHandle: (deps: { nativeView: NativeView; scope: Scope }) => ViewHandle

beforeAll(async () => {
  // Cast via `unknown`: the real export shape need not match this local mirror
  // exactly (the mirror is the contract under test).
  const mod = (await import('./view-handle.js')) as unknown as {
    createViewHandle: (deps: { nativeView: NativeView; scope: Scope }) => ViewHandle
  }
  createViewHandle = mod.createViewHandle
})

// ── Fake ContentViewHost (mirrors compositor.test.ts's makeHost) ─────────────
//
// Faithful to the spike-established semantics so the real compositor's behavior
// is observable: addChildView(known) raises to top, addChildView(new) appends,
// removeChildView drops, addChildView into a destroyed host throws.
type Ref = NativeViewRef
function makeHost(): {
  addChildView(v: Ref): void
  removeChildView(v: Ref): void
  readonly isDestroyed: boolean
  children(): readonly Ref[]
  ids: () => string[]
  setDestroyed: (v: boolean) => void
} {
  const order: Ref[] = []
  let destroyed = false
  return {
    get isDestroyed() {
      return destroyed
    },
    setDestroyed(v: boolean) {
      destroyed = v
    },
    addChildView(v: Ref) {
      if (destroyed) throw new Error('addChildView: contentView is destroyed')
      const i = order.findIndex((x) => x.id === v.id)
      if (i >= 0) order.splice(i, 1)
      order.push(v)
    },
    removeChildView(v: Ref) {
      const i = order.findIndex((x) => x.id === v.id)
      if (i >= 0) order.splice(i, 1)
    },
    children() {
      return order.slice()
    },
    ids: () => order.map((v) => v.id),
  }
}

// ── Fake NativeView with a setBounds spy ─────────────────────────────────────
function makeNativeView(id: string): NativeView & { bounds: Bounds[] } {
  const bounds: Bounds[] = []
  return {
    ref: { id },
    bounds,
    setBounds(b: Bounds) {
      bounds.push(b)
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. placeIn mounts + commits, returns the handle (chainable).
// Pin: placeIn(target,{zone:0}) drives compositor.mount(ref,{zone:0}) then
// commit() so the host gains the view; the call returns the same handle so it
// chains.
// ─────────────────────────────────────────────────────────────────────────────
describe('placeIn — mounts + commits into the target window', () => {
  it('mounts the native view into the host and returns the handle', () => {
    const host = makeHost()
    const compositor = createCompositor(host)
    const windowScope = createScope()
    const nativeView = makeNativeView('v1')
    const handle = createViewHandle({ nativeView, scope: windowScope.child() })

    const returned = handle.placeIn({ compositor, windowScope }, { zone: 0 })

    // The view is now a child of the host (mount + commit ran).
    expect(host.ids()).toContain('v1')
    // Chainable: placeIn returns the same handle instance.
    expect(returned).toBe(handle)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// re-placement corruption.
//
// BACKGROUND: a SECOND `placeIn()` currently OVERWRITES the inner `current` /
// `viewScope` while leaving the OLD viewScope ALIVE. When that old window later
// closes, its per-window teardown reads the now-mutated `current` and detaches/destroys
// the view that has since MOVED to the new window (cross-window corruption).
//
// THE INVARIANT (pinned here): `placeIn()` on an ALREADY-PLACED handle THROWS
// (one placeIn per handle; re-placement is NOT silent). The ONLY migration path
// is `moveTo()`. These two tests guard against placeIn-twice silently
// overwriting (no throw), which is exactly the corruption A2 catches.
// ═════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// A1. a SECOND placeIn on an already-placed handle THROWS — it does NOT silently
//     overwrite current/viewScope.
// Pin: the second placeIn throws (/already placed.*use moveTo/i), AND the FIRST
// placement is intact (the view is still in the FIRST host, never corrupted /
// re-pointed at the second host by a half-applied overwrite).
// ─────────────────────────────────────────────────────────────────────────────
describe('placeIn — a second placeIn throws (one placeIn per handle, N3 fix)', () => {
  it('throws on re-placement and leaves the first placement intact', () => {
    const hostA = makeHost()
    const compositorA = createCompositor(hostA)
    const windowScopeA = createScope()
    const hostB = makeHost()
    const compositorB = createCompositor(hostB)
    const windowScopeB = createScope()
    const nativeView = makeNativeView('v1')
    const handle = createViewHandle({ nativeView, scope: windowScopeA.child() })

    handle.placeIn({ compositor: compositorA, windowScope: windowScopeA }, { zone: 0 })
    expect(hostA.ids()).toContain('v1')

    // A SECOND placeIn must THROW — re-placement is disallowed; moveTo is the path.
    expect(() =>
      handle.placeIn({ compositor: compositorB, windowScope: windowScopeB }, { zone: 0 }),
    ).toThrow(/already placed.*use moveTo/i)

    // The first placement was NOT corrupted: the view is still ONLY in host A
    // (the second placeIn did not overwrite `current` / re-mount into host B).
    expect(hostA.ids()).toContain('v1')
    expect(hostB.ids()).not.toContain('v1')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// A2. (N3 REGRESSION GUARD — THE CRITICAL ONE) the moved view survives an
//     old-window close.
// Pin: placeIn(winA) then moveTo(winB,{rehome:true}); closing winA's windowScope
// must NOT detach/destroy the view that now lives in winB. We assert via the
// compositor/native fakes: after the move + winA-scope close, host B STILL has the
// view, host A does not, and the native view was NEVER destroyed. (Pre-fix, a
// re-placeIn-style overwrite would have left a stale viewScope under winA whose
// close would detach the migrated view from B — the corruption.)
// ─────────────────────────────────────────────────────────────────────────────
describe('moveTo — the moved view survives the old window closing (N3 regression guard)', () => {
  it('closing the SRC windowScope after a rehome:true move does not detach/destroy the view in DEST', async () => {
    const hostA = makeHost()
    const compositorA = createCompositor(hostA)
    const windowScopeA = createScope()

    const hostB = makeHost()
    const compositorB = createCompositor(hostB)
    const windowScopeB = createScope()

    // NativeView with a destroy spy so we can prove the migrated view's WebContents
    // is NEVER destroyed by the old window's close.
    const base = makeNativeView('v1')
    let destroyCalls = 0
    const nativeView: NativeView & { bounds: Bounds[] } = {
      ref: base.ref,
      bounds: base.bounds,
      setBounds: (b) => base.setBounds(b),
      destroy: () => {
        destroyCalls++
      },
    }

    const handle = createViewHandle({ nativeView, scope: windowScopeA.child() })
    handle.placeIn({ compositor: compositorA, windowScope: windowScopeA }, { zone: 0 })
    expect(hostA.ids()).toContain('v1')

    // Migrate to winB AND re-home lifetime to winB (rehome:true).
    await handle.moveTo({ compositor: compositorB, windowScope: windowScopeB }, { zone: 0, rehome: true })
    expect(hostB.ids()).toContain('v1')
    expect(hostA.ids()).not.toContain('v1')

    // Close the OLD window's scope. The migrated view must be untouched: NOT
    // detached from B, and its native view NOT destroyed (no stale viewScope under
    // winA tearing down the now-winB view — the N3 corruption).
    await windowScopeA.close()

    expect(hostB.ids()).toContain('v1') // still in DEST
    expect(hostA.ids()).not.toContain('v1') // never came back to SRC
    expect(destroyCalls).toBe(0) // native view NOT destroyed by the old-window close

    // And it is still LIVE + placeable in B (sink not disabled by the SRC close).
    handle.applyPlacement({ visible: true, bounds: { x: 1, y: 1, width: 1, height: 1 } })
    expect(hostB.ids()).toContain('v1')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. placeIn creates a viewScope UNDER the target windowScope.
// Pin: the handle's lifetime is a CHILD of the target window's `windowScope`, so
// closing the windowScope cascades into the handle — afterward a placement is a
// no-op (sink disabled) AND the view was detached (host no longer has it).
// ─────────────────────────────────────────────────────────────────────────────
describe('placeIn — the handle scope is a child of the target windowScope', () => {
  it('closing the windowScope disposes the handle (later placement is a no-op + view detached)', async () => {
    const host = makeHost()
    const compositor = createCompositor(host)
    const windowScope = createScope()
    const nativeView = makeNativeView('v1')
    // The handle adopts a viewScope that is a CHILD of the windowScope, so the
    // windowScope's close() cascades into it (scope.ts cross-layer LIFO).
    const handle = createViewHandle({ nativeView, scope: windowScope.child() })
    handle.placeIn({ compositor, windowScope }, { zone: 0 })
    expect(host.ids()).toContain('v1')

    // Tear down the WHOLE window: must cascade into the handle's viewScope.
    await windowScope.close()

    // The native view was detached as part of the cascade.
    expect(host.ids()).not.toContain('v1')

    // A placement arriving after the cascade is dropped (sink disabled): no
    // setBounds, no re-mount.
    const boundsBefore = nativeView.bounds.length
    handle.applyPlacement({ visible: true, bounds: { x: 1, y: 2, width: 3, height: 4 } })
    expect(nativeView.bounds.length).toBe(boundsBefore)
    expect(host.ids()).not.toContain('v1')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. applyPlacement(visible:true, bounds) → nativeView.setBounds(bounds).
// Pin: the handle drives bounds DIRECTLY on its native view (handle drives bounds — NOT via the
// compositor). Pin the EXACT bounds forwarded.
// ─────────────────────────────────────────────────────────────────────────────
describe('applyPlacement(visible:true) — drives setBounds directly (handle-drives-bounds)', () => {
  it('forwards the exact bounds to nativeView.setBounds', () => {
    const host = makeHost()
    const compositor = createCompositor(host)
    const windowScope = createScope()
    const nativeView = makeNativeView('v1')
    const handle = createViewHandle({ nativeView, scope: windowScope.child() })
    handle.placeIn({ compositor, windowScope }, { zone: 0 })

    handle.applyPlacement({ visible: true, bounds: { x: 10, y: 20, width: 300, height: 200 } })

    // Exactly the bounds from the placement, set on the native view directly.
    expect(nativeView.bounds).toContainEqual({ x: 10, y: 20, width: 300, height: 200 })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. applyPlacement(visible:false) → detach (unmount + commit), keep-alive.
// Pin: visible:false unmounts + commits so the host no longer has the view (the
// native view object is NOT destroyed — only removed from the host); a
// subsequent visible:true RE-mounts (mount + commit) AND sets bounds (re-attach).
// ─────────────────────────────────────────────────────────────────────────────
describe('applyPlacement(visible:false) — detach-but-keep, then re-attach', () => {
  it('detaches on visible:false and re-mounts + setBounds on visible:true', () => {
    const host = makeHost()
    const compositor = createCompositor(host)
    const windowScope = createScope()
    const nativeView = makeNativeView('v1')
    const handle = createViewHandle({ nativeView, scope: windowScope.child() })
    handle.placeIn({ compositor, windowScope }, { zone: 0 })
    handle.applyPlacement({ visible: true, bounds: { x: 0, y: 0, width: 100, height: 100 } })
    expect(host.ids()).toContain('v1')

    // visible:false → detach (removed from the host), native view kept alive.
    handle.applyPlacement({ visible: false })
    expect(host.ids()).not.toContain('v1')

    // visible:true again → re-mount (back in the host) AND re-set bounds.
    const boundsBefore = nativeView.bounds.length
    handle.applyPlacement({ visible: true, bounds: { x: 5, y: 6, width: 7, height: 8 } })
    expect(host.ids()).toContain('v1')
    expect(nativeView.bounds.length).toBe(boundsBefore + 1)
    expect(nativeView.bounds[nativeView.bounds.length - 1]).toEqual({
      x: 5,
      y: 6,
      width: 7,
      height: 8,
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. dispose() = viewScope.close in A4 order — sink-disable (STEP0) BEFORE the
//    native detach (STEP1).
// Pin: the handle owns the detach (unmount+commit) FIRST and the sink-disable
// LAST on its viewScope, so LIFO teardown runs sink-disable FIRST then detach.
// We instrument call order: a wrapped `compositor.unmount` logs 'detach', and a
// placement issued the instant the sink goes dead is observable — so we assert
// the sink stopped accepting bounds BEFORE the detach fired (no setBounds after
// the detach marker), and that dispose detaches + empties the host.
// ─────────────────────────────────────────────────────────────────────────────
describe('dispose() — A4 order: sink-disable (STEP0) before native detach (STEP1)', () => {
  it('runs the placement-sink disable before the compositor detach', async () => {
    const host = makeHost()
    const realCompositor = createCompositor(host)
    const windowScope = createScope()
    const nativeView = makeNativeView('v1')

    // Instrument both observable native effects into one ordered log:
    //   - 'detach'   = the compositor.unmount the handle owns (STEP1).
    //   - 'setBounds'= the native sink firing (only happens while the sink is
    //                  LIVE; once STEP0 disables it, no further setBounds).
    const order: string[] = []
    const compositor: Compositor = {
      mount: (v, opts) => realCompositor.mount(v, opts),
      reorder: (id, opts) => realCompositor.reorder(id, opts),
      commit: () => realCompositor.commit(),
      unmount: (id) => {
        order.push('detach')
        realCompositor.unmount(id)
      },
    }
    const spiedView: NativeView = {
      ref: nativeView.ref,
      setBounds: (b) => {
        order.push('setBounds')
        nativeView.setBounds(b)
      },
    }

    const handle = createViewHandle({ nativeView: spiedView, scope: windowScope.child() })
    handle.placeIn({ compositor, windowScope }, { zone: 0 })
    handle.applyPlacement({ visible: true, bounds: { x: 0, y: 0, width: 10, height: 10 } })
    expect(order).toEqual(['setBounds']) // sink was live and fired once

    await handle.dispose()

    // (a) dispose detached the view → host empty.
    expect(host.ids()).toEqual([])
    // The detach happened during dispose.
    expect(order).toContain('detach')
    // (b) STEP0 (sink disable) ran before STEP1 (detach): there is NO 'setBounds'
    // after the 'detach' marker — the sink was already dead by the time the
    // native detach fired (it owns sink-disable LAST → LIFO runs it FIRST).
    const detachAt = order.indexOf('detach')
    expect(order.slice(detachAt + 1).includes('setBounds')).toBe(false)
    // And no setBounds was driven during teardown at all (sink dead first).
    expect(order.filter((e) => e === 'setBounds').length).toBe(1) // only the pre-dispose one

    // Cross-check the sink is inert post-dispose (a placement now does nothing).
    handle.applyPlacement({ visible: true, bounds: { x: 9, y: 9, width: 9, height: 9 } })
    expect(order.filter((e) => e === 'setBounds').length).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 6. a late applyPlacement after dispose is a NO-OP (idempotent late IPC).
// Pin: after dispose(), applyPlacement does NOTHING — no setBounds, no mount.
// Real cross-process `place` IPC can arrive after teardown; the sink drops it.
// ─────────────────────────────────────────────────────────────────────────────
describe('applyPlacement after dispose — idempotent late IPC (the (b) risk)', () => {
  it('drops a place frame that arrives after dispose (no setBounds, no mount)', async () => {
    const host = makeHost()
    const compositor = createCompositor(host)
    const windowScope = createScope()
    const nativeView = makeNativeView('v1')
    const handle = createViewHandle({ nativeView, scope: windowScope.child() })
    handle.placeIn({ compositor, windowScope }, { zone: 0 })
    handle.applyPlacement({ visible: true, bounds: { x: 1, y: 1, width: 1, height: 1 } })

    await handle.dispose()
    expect(host.ids()).toEqual([]) // detached on dispose

    const boundsBefore = nativeView.bounds.length
    // A `place` IPC arriving AFTER teardown must be dropped entirely.
    handle.applyPlacement({ visible: true, bounds: { x: 2, y: 2, width: 2, height: 2 } })
    expect(nativeView.bounds.length).toBe(boundsBefore) // no setBounds
    expect(host.ids()).toEqual([]) // no re-mount
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 7. detach during dispose is silent on a destroyed host.
// Pin: with host.isDestroyed === true, dispose() still resolves and does NOT
// throw — the detach's removals-only commit hits the teardown-friendly path.
// ─────────────────────────────────────────────────────────────────────────────
describe('dispose() — silent detach on a destroyed host', () => {
  it('does not throw when the host is destroyed (removals-only teardown path)', async () => {
    const host = makeHost()
    const compositor = createCompositor(host)
    const windowScope = createScope()
    const nativeView = makeNativeView('v1')
    const handle = createViewHandle({ nativeView, scope: windowScope.child() })
    handle.placeIn({ compositor, windowScope }, { zone: 0 })
    handle.applyPlacement({ visible: true, bounds: { x: 0, y: 0, width: 1, height: 1 } })
    expect(host.ids()).toContain('v1')

    // The window's contentView is torn down; its views died with it.
    host.setDestroyed(true)
    // dispose's detach commit is removals-only → silent on a destroyed host.
    await expect(handle.dispose()).resolves.toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// KA-5 [NEW PIN] — combined detach+destroy disposer: a detach commit that THROWS
// (native apply-failure on a LIVE host; compositor rollback restores the attached
// snapshot) must NOT reach destroy. Detach + destroy are ONE viewScope disposer,
// so the throw propagates before destroy runs — never destroy a WebContents while
// its view is still attached to a live contentView.
//
// Pin: arm the teardown detach commit to throw. dispose()'s viewScope.close
// rejects, and the native `destroy` spy was NEVER called (destroy is gated behind
// a clean detach). Contrast the happy-path tests above where detach succeeds and
// destroy therefore runs (keepalive #1/#2). We assert via a `destroy` spy on the
// injected NativeView (the deck-app wires this to webContents.close()).
// ─────────────────────────────────────────────────────────────────────────────
describe('KA-5 [NEW PIN] — a throwing detach skips destroy (combined disposer)', () => {
  it('does not call nativeView.destroy when the teardown detach commit throws', async () => {
    const host = makeHost()
    const realCompositor = createCompositor(host)
    const windowScope = createScope()
    const base = makeNativeView('v1')

    // Arm the NEXT commit() to throw a CommitError (the teardown detach). placeIn
    // issues a mount-commit first, so only the teardown commit is armed.
    let armThrow = false
    const compositor: Compositor = {
      mount: (v, opts) => realCompositor.mount(v, opts),
      reorder: (id, opts) => realCompositor.reorder(id, opts),
      unmount: (id) => realCompositor.unmount(id),
      commit: () => {
        if (armThrow) {
          throw new CommitError({
            kind: 'apply-failed',
            applied: 'partial',
            recovered: true,
            message: 'flaky teardown commit',
          })
        }
        realCompositor.commit()
      },
    }

    // NativeView WITH a destroy spy (deck-app injects webContents.close here).
    let destroyCalls = 0
    const nativeView: NativeView & { destroy(): void } = {
      ref: base.ref,
      setBounds: (b) => base.setBounds(b),
      destroy: () => {
        destroyCalls++
      },
    }

    const handle = createViewHandle({
      nativeView: nativeView as unknown as NativeView,
      scope: windowScope.child(),
    })
    handle.placeIn({ compositor, windowScope }, { zone: 0 })
    expect(host.ids()).toContain('v1')

    // Arm the teardown detach commit to throw, then dispose: the combined disposer
    // unmounts + commits (THROWS) → the throw propagates → destroy is NOT reached.
    // viewScope.close() surfaces a disposer throw as an AggregateError whose
    // `errors` carry the underlying CommitError — assert both the reject and that
    // the original CommitError is the cause inside it.
    armThrow = true
    let caught: unknown
    await handle.dispose().catch((e) => {
      caught = e
    })
    expect(caught).toBeTruthy()
    const errors = (caught as { errors?: unknown[] }).errors ?? [caught]
    expect(errors.some((e) => e instanceof CommitError)).toBe(true)

    // The guarantee: destroy was NEVER called (the view may still be attached to a
    // live contentView — closing its WebContents now would dangle the child).
    expect(destroyCalls).toBe(0)
  })

  it('DOES call nativeView.destroy on the happy path (detach succeeds → destroy runs)', async () => {
    const host = makeHost()
    const compositor = createCompositor(host)
    const windowScope = createScope()
    const base = makeNativeView('v1')

    let destroyCalls = 0
    const nativeView: NativeView & { destroy(): void } = {
      ref: base.ref,
      setBounds: (b) => base.setBounds(b),
      destroy: () => {
        destroyCalls++
      },
    }

    const handle = createViewHandle({
      nativeView: nativeView as unknown as NativeView,
      scope: windowScope.child(),
    })
    handle.placeIn({ compositor, windowScope }, { zone: 0 })

    await handle.dispose()

    // Detach succeeded → destroy ran (exactly once), and the host is empty.
    expect(host.ids()).toEqual([])
    expect(destroyCalls).toBe(1)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// createViewHandle — moveTo (cross-window, view-handle.md「moveTo 跨窗迁移」)
//
// `moveTo(dest, { zone, rehome? }): Promise<void>` moves a view that is
// currently placed in `src` to `dest` (another { compositor, windowScope }
// target) as TWO independent Compositor commits guarded by a per-view async
// mutex (migrationLock), driving the「moveTo 事务状态机」state machine:
//
//     AT_SRC → DETACHED → AT_DEST                 (happy path)
//            └→ (src.commit throws) → AT_SRC       (idempotent failure, rethrow)
//     DETACHED → (dest.commit throws) → ROLLBACK → AT_SRC   (rethrow dest error)
//                                                └→ CLOSED   (src re-mount ALSO throws)
//
// moveTo 迁移显示而非寿命 RESOLUTION (DECISION pinned here as a contract comment, asserted
// indirectly by test 6): moveTo moves DISPLAY (the compositor token) and, only
// when `rehome:true`, LIFETIME (via `srcWindowScope.adopt(viewScope,
// destWindowScope)`). It does NOT carry capability grants — the dest window's
// own control layer issues its own grant. No test here mounts/asserts a grant
// transfer, BECAUSE moveTo must not touch grants (the decision is "out of
// scope" by construction). See view-handle.md「moveTo 迁移显示而非寿命」.
// ═════════════════════════════════════════════════════════════════════════════

// ── Flaky compositor wrapper (mirrors compositor.test.ts's makeFlakyHost / the
//    compositor-and-teardown.md「commit 精确失败语义」pattern): wrap a REAL compositor so a chosen commit() call throws a
//    CommitError, letting us drive each state-machine edge. `failCommitOn(nth)`
//    makes the Nth commit() invocation throw; subsequent commits succeed (so a
//    ROLLBACK re-mount on the same compositor can still land). `failCommitAll`
//    makes EVERY commit() throw (so even a rollback re-mount dies → CLOSED). ──
function makeFlakyCompositor(
  host: ReturnType<typeof makeHost>,
): {
  compositor: Compositor
  failCommitOn: (nth: number) => void
  failCommitAll: () => void
  commitCount: () => number
} {
  const real = createCompositor(host)
  let armedNth = -1
  let armedAll = false
  let count = 0
  const compositor: Compositor = {
    mount: (v, opts) => real.mount(v, opts),
    unmount: (id) => real.unmount(id),
    reorder: (id, opts) => real.reorder(id, opts),
    commit: () => {
      count++
      if (armedAll || count === armedNth) {
        // A typed CommitError, exactly what the real commit throws and what the
        // moveTo state machine consumes (compositor-and-teardown.md「commit 的可回滚保证」).
        throw new CommitError({
          kind: 'apply-failed',
          applied: 'partial',
          recovered: true,
          message: 'flaky compositor: commit rejected',
        })
      }
      real.commit()
    },
  }
  return {
    compositor,
    failCommitOn: (nth) => {
      armedNth = nth
    },
    failCommitAll: () => {
      armedAll = true
    },
    commitCount: () => count,
  }
}

// Build a placed handle in `src` plus a fresh `dest` target. Returns the pieces
// the move tests assert against.
function placeInSrc(viewId: string): {
  handle: ViewHandle
  nativeView: NativeView & { bounds: Bounds[] }
  srcHost: ReturnType<typeof makeHost>
  srcWindowScope: Scope
  src: PlaceTarget
} {
  const srcHost = makeHost()
  const srcCompositor = createCompositor(srcHost)
  const srcWindowScope = createScope()
  const nativeView = makeNativeView(viewId)
  const handle = createViewHandle({ nativeView, scope: srcWindowScope.child() })
  const src: PlaceTarget = { compositor: srcCompositor, windowScope: srcWindowScope }
  handle.placeIn(src, { zone: 0 })
  return { handle, nativeView, srcHost, srcWindowScope, src }
}

function makeDest(): {
  destHost: ReturnType<typeof makeHost>
  destWindowScope: Scope
  dest: PlaceTarget
} {
  const destHost = makeHost()
  const destCompositor = createCompositor(destHost)
  const destWindowScope = createScope()
  const dest: PlaceTarget = { compositor: destCompositor, windowScope: destWindowScope }
  return { destHost, destWindowScope, dest }
}

describe('createViewHandle — moveTo (cross-window, moveTo cross-window migration)', () => {
  // ───────────────────────────────────────────────────────────────────────────
  // 1. happy path AT_SRC → DETACHED → AT_DEST.
  // Pin: await moveTo(dest,{zone}) → src.unmount+commit (view leaves src host),
  // then dest.mount(ref)+commit (view in dest host); no throw. After the move the
  // handle's compositor token is dest, so applyPlacement drives the view against
  // the DEST host (visible:false there detaches from dest, not src).
  // ───────────────────────────────────────────────────────────────────────────
  it('moves the view from src host to dest host (no throw) and re-binds to dest', async () => {
    const { handle, srcHost } = placeInSrc('v1')
    const { destHost, dest } = makeDest()
    expect(srcHost.ids()).toContain('v1')
    expect(destHost.ids()).not.toContain('v1')

    await expect(handle.moveTo(dest, { zone: 0 })).resolves.toBeUndefined()

    // View left src, landed in dest (two independent commits, moveTo 事务状态机).
    expect(srcHost.ids()).not.toContain('v1')
    expect(destHost.ids()).toContain('v1')

    // The compositor token moved: applyPlacement now drives DEST. A visible:true
    // keeps it mounted in dest + sets bounds; a visible:false detaches from dest.
    handle.applyPlacement({ visible: true, bounds: { x: 1, y: 2, width: 3, height: 4 } })
    expect(destHost.ids()).toContain('v1')
    handle.applyPlacement({ visible: false })
    expect(destHost.ids()).not.toContain('v1')
    expect(srcHost.ids()).not.toContain('v1')
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 2. src.commit() throws → stays AT_SRC, rethrows, no side effect (idempotent).
  // Pin: arm the SRC commit to throw. moveTo rejects with the CommitError; the
  // view is STILL in src host (it never left — unmount intent rolled back or
  // never applied), and dest host is UNTOUCHED.
  // ───────────────────────────────────────────────────────────────────────────
  it('AT_SRC: src.commit throwing leaves the view in src, dest untouched, and rethrows', async () => {
    // Re-create src with a FLAKY compositor whose first commit throws.
    const srcHost = makeHost()
    const flakySrc = makeFlakyCompositor(srcHost)
    const srcWindowScope = createScope()
    const nativeView = makeNativeView('v1')
    const handle = createViewHandle({ nativeView, scope: srcWindowScope.child() })
    // placeIn issues commit #1 (the mount) on the real path — arm the NEXT commit
    // (the move's src detach) to throw.
    handle.placeIn({ compositor: flakySrc.compositor, windowScope: srcWindowScope }, { zone: 0 })
    expect(srcHost.ids()).toContain('v1')
    flakySrc.failCommitOn(flakySrc.commitCount() + 1) // the move's src.commit

    const { destHost, dest } = makeDest()

    await expect(handle.moveTo(dest, { zone: 0 })).rejects.toBeInstanceOf(CommitError)

    // View never left src (STEP 1 failed before/without detaching native), dest
    // host untouched — the failure is idempotent / side-effect-free.
    expect(srcHost.ids()).toContain('v1')
    expect(destHost.ids()).not.toContain('v1')
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 3. dest.commit() throws → ROLLBACK → AT_SRC, rethrows the DEST error.
  // Pin: src detach succeeds (view leaves src), then dest.commit throws. moveTo
  // ROLLS BACK by re-mounting on src (src.mount(ref)+commit), so the view is back
  // in src host (I2: never dangling), and rethrows the dest CommitError. dest host
  // does NOT have the view.
  // ───────────────────────────────────────────────────────────────────────────
  it('ROLLBACK: dest.commit throwing re-mounts on src and rethrows the dest error', async () => {
    const { handle, srcHost } = placeInSrc('v1')

    // dest with a flaky compositor whose FIRST commit (the move's dest mount)
    // throws — but later commits succeed (irrelevant here; src rollback uses the
    // src compositor).
    const destHost = makeHost()
    const flakyDest = makeFlakyCompositor(destHost)
    flakyDest.failCommitOn(1)
    const destWindowScope = createScope()
    const dest: PlaceTarget = { compositor: flakyDest.compositor, windowScope: destWindowScope }

    await expect(handle.moveTo(dest, { zone: 0 })).rejects.toBeInstanceOf(CommitError)

    // ROLLBACK landed the view back in src (re-mounted), dest never got it.
    expect(srcHost.ids()).toContain('v1')
    expect(destHost.ids()).not.toContain('v1')
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 4. dest AND src-rollback both throw → CLOSED.
  // Pin: src detach ok, dest.commit throws, AND the ROLLBACK src.commit ALSO
  // throws → the view is homeless → moveTo CLOSES the view (viewScope.close ⇒
  // dispose) and rejects. A later applyPlacement is a no-op (view in neither
  // host).
  // ───────────────────────────────────────────────────────────────────────────
  it('CLOSED: dest.commit AND src-rollback both throwing closes the view and rejects', async () => {
    // src with a flaky compositor: the move's src detach commit succeeds, but the
    // ROLLBACK re-mount commit throws → arm failCommitAll AFTER the detach.
    const srcHost = makeHost()
    const flakySrc = makeFlakyCompositor(srcHost)
    const srcWindowScope = createScope()
    const nativeView = makeNativeView('v1')
    const handle = createViewHandle({ nativeView, scope: srcWindowScope.child() })
    handle.placeIn({ compositor: flakySrc.compositor, windowScope: srcWindowScope }, { zone: 0 })

    // dest commit always throws (the dest mount fails).
    const destHost = makeHost()
    const flakyDest = makeFlakyCompositor(destHost)
    flakyDest.failCommitAll()
    const destWindowScope = createScope()
    const dest: PlaceTarget = { compositor: flakyDest.compositor, windowScope: destWindowScope }

    // Let the SRC detach commit (the move's STEP 1) succeed, then make every
    // further src commit throw — so the ROLLBACK re-mount on src ALSO fails.
    // NOTE (test-bug fix, flagged): the original ALSO called `failCommitAll()`
    // here, which armed EVERY src commit — including STEP 1's detach commit — so
    // v1 (added to srcHost during placeIn, before arming) could never be removed,
    // making the `srcHost` assertion below unsatisfiable and contradicting this
    // comment. `failCommitOn(commitCount()+2)` alone correctly encodes the
    // intended CLOSED scenario (detach +1 ok → dest fails → rollback +2 throws).
    flakySrc.failCommitOn(flakySrc.commitCount() + 2) // detach ok (+1), rollback (+2) throws

    await expect(handle.moveTo(dest, { zone: 0 })).rejects.toBeTruthy()

    // The view is homeless → CLOSED: neither host has it, and the handle is
    // disposed (a later placement is a no-op against both hosts).
    expect(destHost.ids()).not.toContain('v1')
    const srcBoundsLen = nativeView.bounds.length
    handle.applyPlacement({ visible: true, bounds: { x: 9, y: 9, width: 9, height: 9 } })
    expect(nativeView.bounds.length).toBe(srcBoundsLen) // sink dead (disposed)
    expect(srcHost.ids()).not.toContain('v1')
    expect(destHost.ids()).not.toContain('v1')
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 5. migrationLock serializes concurrent moves (I2): the view is never in two
  //    hosts at once / never double-mounted.
  // Pin: fire moveTo(A→B) and moveTo(B→A)-equivalent (here: two moveTo calls on
  //    the SAME handle) WITHOUT awaiting the first. The per-view async mutex
  //    serializes them FIFO; at no observed point is the view in two hosts at
  //    once, and BOTH settle. We use a deferred-gated commit to interleave: if the
  //    lock did NOT serialize, the second move would interleave its mount before
  //    the first finished and the view would briefly be double-hosted.
  // ───────────────────────────────────────────────────────────────────────────
  it('migrationLock serializes two concurrent moveTo calls (view never double-hosted, both settle)', async () => {
    const { handle, srcHost } = placeInSrc('v1')
    const { destHost: hostB, dest: targetB } = makeDest()
    const { destHost: hostC, dest: targetC } = makeDest()

    // Sample "how many hosts hold the view" repeatedly while the moves run; the
    // invariant (I2) is that this is NEVER 2.
    const hosts = [srcHost, hostB, hostC]
    let maxConcurrentHosts = 0
    const sample = (): void => {
      const n = hosts.filter((h) => h.ids().includes('v1')).length
      if (n > maxConcurrentHosts) maxConcurrentHosts = n
    }

    // Fire both moves without awaiting the first; the lock must FIFO-serialize.
    const m1 = handle.moveTo(targetB, { zone: 0 })
    sample()
    const m2 = handle.moveTo(targetC, { zone: 0 })
    sample()

    await Promise.all([m1, m2])
    sample()

    // Both settled, and the view was never in two hosts at once (I2 held).
    expect(maxConcurrentHosts).toBeLessThanOrEqual(1)
    // FIFO: the SECOND move wins the final position (it ran last) → host C.
    expect(hostC.ids()).toContain('v1')
    expect(srcHost.ids()).not.toContain('v1')
    expect(hostB.ids()).not.toContain('v1')
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 6. rehome via Scope.adopt — placement ≠ lifetime.
  // Pin: moveTo(dest,{zone, rehome:true}) calls srcWindowScope.adopt(viewScope,
  // destWindowScope), re-parenting the viewScope under DEST's windowScope. So
  // AFTER rehome, closing the DEST windowScope tears the view down (its
  // applyPlacement becomes a no-op), whereas closing the SRC windowScope does
  // NOT. WITHOUT rehome, the opposite: closing SRC still tears it down.
  // ───────────────────────────────────────────────────────────────────────────
  it('rehome:true re-parents the viewScope so DEST windowScope close tears it down (not SRC)', async () => {
    const { handle, srcWindowScope } = placeInSrc('v1')
    const { destHost, destWindowScope, dest } = makeDest()

    await handle.moveTo(dest, { zone: 0, rehome: true })
    expect(destHost.ids()).toContain('v1')

    // Closing SRC windowScope must NOT tear the view down (lifetime re-homed to
    // dest): the sink stays live, a placement still drives the dest host.
    await srcWindowScope.close()
    handle.applyPlacement({ visible: true, bounds: { x: 1, y: 1, width: 1, height: 1 } })
    expect(destHost.ids()).toContain('v1') // still alive + placeable

    // Closing DEST windowScope DOES tear it down (cascade into the re-homed
    // viewScope): detached, and a later placement is a no-op.
    await destWindowScope.close()
    expect(destHost.ids()).not.toContain('v1')
    handle.applyPlacement({ visible: true, bounds: { x: 2, y: 2, width: 2, height: 2 } })
    expect(destHost.ids()).not.toContain('v1') // sink dead, no re-mount
  })

  it('without rehome, closing the SRC windowScope still tears the view down (lifetime stays at src)', async () => {
    const { handle, srcWindowScope } = placeInSrc('v1')
    const { destHost, dest } = makeDest()

    // Move DISPLAY only (no rehome) — lifetime stays under src windowScope.
    await handle.moveTo(dest, { zone: 0 })
    expect(destHost.ids()).toContain('v1')

    // Closing SRC windowScope cascades into the (still-src-owned) viewScope and
    // tears the view down even though it is displayed in dest.
    await srcWindowScope.close()
    handle.applyPlacement({ visible: true, bounds: { x: 3, y: 3, width: 3, height: 3 } })
    expect(destHost.ids()).not.toContain('v1') // sink dead, no re-mount
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 7. chainable note: moveTo returns Promise<void> (terminal, not chainable);
  //    pin that it is awaitable and resolves to undefined (placeIn stays the
  //    chainable one — moveTo does not).
  // ───────────────────────────────────────────────────────────────────────────
  it('moveTo returns an awaitable Promise<void> (terminal, not chainable)', async () => {
    const { handle } = placeInSrc('v1')
    const { dest } = makeDest()

    const ret = handle.moveTo(dest, { zone: 0 })
    expect(typeof (ret as Promise<void>).then).toBe('function')
    await expect(ret).resolves.toBeUndefined()
  })

  // ───────────────────────────────────────────────────────────────────────────
  // a rehome/adopt FAILURE rolls back FULLY to source (no partial divergence
  // between native + lifetime).
  //
  // Bug: the native dest commit + `current=dest` happened BEFORE Scope.adopt. If
  // adopt threw, the inner did NOT undo the native commit → the view was detached
  // from src while compositor/`current` pointed at dest (native ↔ lifetime
  // diverge). Fix: on adopt failure, unmount dest + re-mount src + restore
  // `current=src`. Post-condition: moveTo either fully succeeds or fully rolls
  // back. We force adopt to throw by CLOSING the dest windowScope before the move
  // (adopt rejects: "newParent scope is not alive"); the native dest compositor is
  // independent of its windowScope, so the native dest commit still lands first.
  // ───────────────────────────────────────────────────────────────────────────
  it('a rehome/adopt failure leaves the view in SOURCE (re-mounted, current=src), rejects, no dest residue', async () => {
    const { handle, srcHost, nativeView } = placeInSrc('v1')
    const { destHost, destWindowScope, dest } = makeDest()
    expect(srcHost.ids()).toContain('v1')

    // Kill the dest windowScope so the rehome `adopt(viewScope, destWindowScope)`
    // rejects (dead newParent) AFTER the native dest commit has already landed.
    await destWindowScope.close()

    await expect(handle.moveTo(dest, { zone: 0, rehome: true })).rejects.toBeTruthy()

    // FULL rollback: the view is back in SRC (re-mounted), dest has NO residue.
    expect(srcHost.ids()).toContain('v1')
    expect(destHost.ids()).not.toContain('v1')

    // `current` was restored to src (NOT left pointing at dest): a subsequent
    // applyPlacement drives the SRC host, and a visible:false detaches from SRC.
    const boundsBefore = nativeView.bounds.length
    handle.applyPlacement({ visible: true, bounds: { x: 1, y: 1, width: 1, height: 1 } })
    expect(nativeView.bounds.length).toBe(boundsBefore + 1) // sink live (NOT disposed)
    expect(srcHost.ids()).toContain('v1')
    handle.applyPlacement({ visible: false })
    expect(srcHost.ids()).not.toContain('v1') // detached from SRC, not dest
    expect(destHost.ids()).not.toContain('v1')
  })

  // ───────────────────────────────────────────────────────────────────────────
  // applyPlacement is a NO-OP while a moveTo is in flight (a stale source place
  // frame cannot drive the view mid-migration).
  //
  // Bug: during the awaited migration (esp. the adopt window) `current` points at
  // dest while the SOURCE slot token is still registered → a stale source `place`
  // could route through to inner.applyPlacement and setBounds mid-migration. Fix:
  // drop place frames while the migrationLock is held (`migrating` guard). We park
  // the move INSIDE the adopt by giving the dest windowScope an in-flight reset
  // fence (adopt waits behind it), call applyPlacement during the park, and assert
  // NO setBounds fired; then release and let the move complete.
  // ───────────────────────────────────────────────────────────────────────────
  it('an applyPlacement arriving while a moveTo is in flight is dropped (no setBounds mid-migration)', async () => {
    const { handle, nativeView } = placeInSrc('v1')
    const { destHost, destWindowScope, dest } = makeDest()

    // Arm an in-flight reset fence on the dest windowScope: a slow async disposer
    // the move's `adopt` must park behind (scope.adopt waits for an in-flight
    // fence). This freezes the move INSIDE doMove, after `current=dest`.
    let releaseFence!: () => void
    const fenceBlocked = new Promise<void>((r) => {
      releaseFence = r
    })
    destWindowScope.own(async () => {
      await fenceBlocked
    })
    const resetFence = destWindowScope.reset() // in-flight teardown

    const boundsBefore = nativeView.bounds.length
    const movePromise = handle.moveTo(dest, { zone: 0, rehome: true })
    // Let the move advance to the adopt park (a microtask turn or two).
    await Promise.resolve()
    await Promise.resolve()

    // A stale `place` arrives mid-migration → MUST be dropped (no setBounds).
    handle.applyPlacement({ visible: true, bounds: { x: 5, y: 5, width: 5, height: 5 } })
    expect(nativeView.bounds.length).toBe(boundsBefore) // dropped, no setBounds

    // Release the fence → adopt proceeds → the move completes successfully.
    releaseFence()
    await resetFence
    await movePromise
    expect(destHost.ids()).toContain('v1')

    // After the move settles, applyPlacement works again (drives the DEST host).
    handle.applyPlacement({ visible: true, bounds: { x: 6, y: 7, width: 8, height: 9 } })
    expect(nativeView.bounds).toContainEqual({ x: 6, y: 7, width: 8, height: 9 })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // a concurrent dispose() is serialized with an in-flight moveTo (runs AFTER
  // the move settles, not concurrently).
  //
  // Bug: dispose closed the viewScope independently and could race an in-flight
  // move (the migrationLock only guarded moveTo) → corruption / double-teardown.
  // Fix: dispose acquires the same migrationLock, so it runs after the move. We
  // park the move inside the adopt (in-flight reset fence), fire dispose() during
  // the park, assert it has NOT resolved (it is queued behind the move), then
  // release: the move completes, THEN dispose runs cleanly, destroying the view.
  // ───────────────────────────────────────────────────────────────────────────
  it('dispose() during an in-flight moveTo waits for the move to settle, then disposes cleanly (view destroyed, no double-teardown)', async () => {
    const { destHost: dHost, destWindowScope, dest } = makeDest()

    // A fresh placed handle WITH a destroy spy so we can observe the (single)
    // teardown destroy the native view.
    let destroyCalls = 0
    const base = makeNativeView('w1')
    const srcHost2 = makeHost()
    const srcCompositor2 = createCompositor(srcHost2)
    const srcWindowScope2 = createScope()
    const nativeView2: NativeView & { bounds: Bounds[] } = {
      ref: base.ref,
      bounds: base.bounds,
      setBounds: (b) => base.setBounds(b),
      destroy: () => {
        destroyCalls++
      },
    }
    const handle2 = createViewHandle({ nativeView: nativeView2, scope: srcWindowScope2.child() })
    handle2.placeIn({ compositor: srcCompositor2, windowScope: srcWindowScope2 }, { zone: 0 })

    // Park the move inside adopt via an in-flight reset fence on the dest scope.
    let releaseFence!: () => void
    const fenceBlocked = new Promise<void>((r) => {
      releaseFence = r
    })
    destWindowScope.own(async () => {
      await fenceBlocked
    })
    const resetFence = destWindowScope.reset()

    const movePromise = handle2.moveTo(dest, { zone: 0, rehome: true })
    await Promise.resolve()
    await Promise.resolve()

    // dispose() fired mid-move MUST queue behind the migrationLock — it has NOT
    // resolved while the move is still parked.
    let disposeSettled = false
    const disposePromise = handle2.dispose().then(() => {
      disposeSettled = true
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(disposeSettled).toBe(false) // serialized: waiting for the move
    expect(destroyCalls).toBe(0) // not torn down yet

    // Release the move → it completes → THEN dispose runs (after the lock frees).
    releaseFence()
    await resetFence
    await movePromise
    await disposePromise

    // Clean single teardown: the view is destroyed exactly once, detached from the
    // dest host (its final home), no double-teardown.
    expect(disposeSettled).toBe(true)
    expect(destroyCalls).toBe(1)
    expect(dHost.ids()).not.toContain('v1')
    expect(dHost.ids()).not.toContain('w1')
  })
})
