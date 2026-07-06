import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPlacementPublisher } from './placement-publisher.js'
import type { DesiredView, PlacementSnapshot } from '../layout/index.js'

// Fake rAF scheduler — drives frame delivery without real timers.
class FakeRaf {
  private cbs = new Map<number, () => void>()
  private nextId = 1
  request = vi.fn((cb: () => void): number => {
    const id = this.nextId++
    this.cbs.set(id, cb)
    return id
  })
  cancel = vi.fn((id: number): void => {
    this.cbs.delete(id)
  })
  /** Drain exactly the callbacks pending at call-time; re-requests land in next flush. */
  flushFrame(): void {
    const pending = [...this.cbs.entries()]
    this.cbs.clear()
    for (const [, cb] of pending) cb()
  }
  get pending(): number {
    return this.cbs.size
  }
}

// Helpers for building test fixtures.
function makeView(viewId: string, visible = true): DesiredView {
  return {
    viewId,
    layer: 0,
    placement: visible
      ? { visible: true, bounds: { x: 0, y: 0, width: 100, height: 100 } }
      : { visible: false },
  }
}

describe('createPlacementPublisher', () => {
  let raf: FakeRaf
  // A typed-impl mock: it stays assignable to the `(snapshot) => void` deps
  // field (unlike an impl-less `vi.fn()`, whose type carries a construct
  // signature) AND records each published snapshot in a typed array so
  // assertions read well-typed values instead of `mock.calls`'s `any[][]`.
  const snapshots: PlacementSnapshot[] = []
  const publish = vi.fn((snap: PlacementSnapshot): void => {
    snapshots.push(snap)
  })
  const nthSnapshot = (n: number): PlacementSnapshot => {
    const snap = snapshots[n]
    if (!snap) throw new Error(`no published snapshot at index ${n}`)
    return snap
  }

  beforeEach(() => {
    raf = new FakeRaf()
    snapshots.length = 0
    publish.mockClear()
  })

  // ── Contract 1: frame-coalesced publish ──────────────────────────────────

  describe('frame-coalesced publish', () => {
    it('does not publish synchronously after set', () => {
      const publisher = createPlacementPublisher({
        generation: 1,
        publish,
        requestFrame: raf.request,
        cancelFrame: raf.cancel,
      })
      publisher.set(makeView('a'))
      expect(publish).not.toHaveBeenCalled()
    })

    it('publishes on the next frame after set', () => {
      const publisher = createPlacementPublisher({
        generation: 1,
        publish,
        requestFrame: raf.request,
        cancelFrame: raf.cancel,
      })
      publisher.set(makeView('a'))
      raf.flushFrame()
      expect(publish).toHaveBeenCalledOnce()
      const snap = nthSnapshot(0)
      expect(snap.views).toHaveLength(1)
      expect(snap.views[0]!.viewId).toBe('a')
    })
  })

  // ── Contract 2: same-frame coalescing ────────────────────────────────────

  describe('same-frame coalescing', () => {
    it('collapses multiple set calls for the same viewId to the last value', () => {
      const publisher = createPlacementPublisher({
        generation: 1,
        publish,
        requestFrame: raf.request,
        cancelFrame: raf.cancel,
      })
      const first = makeView('a')
      const last: DesiredView = {
        viewId: 'a',
        layer: 5,
        placement: { visible: false },
      }
      publisher.set(first)
      publisher.set(last)
      raf.flushFrame()
      expect(publish).toHaveBeenCalledOnce()
      const snap = nthSnapshot(0)
      expect(snap.views).toHaveLength(1)
      expect(snap.views[0]!.layer).toBe(5)
      expect(snap.views[0]!.placement.visible).toBe(false)
    })

    it('merges different viewIds from the same frame into one snapshot', () => {
      const publisher = createPlacementPublisher({
        generation: 1,
        publish,
        requestFrame: raf.request,
        cancelFrame: raf.cancel,
      })
      publisher.set(makeView('a'))
      publisher.set(makeView('b'))
      raf.flushFrame()
      expect(publish).toHaveBeenCalledOnce()
      const snap = nthSnapshot(0)
      const ids = snap.views.map((v) => v.viewId).sort()
      expect(ids).toEqual(['a', 'b'])
    })

    it('only calls requestFrame once per dirty frame regardless of set call count', () => {
      const publisher = createPlacementPublisher({
        generation: 1,
        publish,
        requestFrame: raf.request,
        cancelFrame: raf.cancel,
      })
      publisher.set(makeView('a'))
      publisher.set(makeView('b'))
      publisher.set(makeView('a'))
      expect(raf.request).toHaveBeenCalledOnce()
    })
  })

  // ── Contract 3: remove ───────────────────────────────────────────────────

  describe('remove', () => {
    it('excludes a removed viewId from the next published snapshot', () => {
      const publisher = createPlacementPublisher({
        generation: 1,
        publish,
        requestFrame: raf.request,
        cancelFrame: raf.cancel,
      })
      publisher.set(makeView('a'))
      publisher.set(makeView('b'))
      raf.flushFrame()
      snapshots.length = 0
      publish.mockClear()

      publisher.remove('a')
      raf.flushFrame()
      const snap = nthSnapshot(0)
      const ids = snap.views.map((v) => v.viewId)
      expect(ids).not.toContain('a')
      expect(ids).toContain('b')
    })

    it('schedules a publish when remove is called with an existing viewId', () => {
      const publisher = createPlacementPublisher({
        generation: 1,
        publish,
        requestFrame: raf.request,
        cancelFrame: raf.cancel,
      })
      publisher.set(makeView('a'))
      raf.flushFrame()
      publish.mockClear()

      publisher.remove('a')
      raf.flushFrame()
      expect(publish).toHaveBeenCalledOnce()
    })
  })

  // ── Contract 4: dirty gate ───────────────────────────────────────────────

  describe('dirty gate', () => {
    it('does not publish when a frame fires with no pending changes', () => {
      createPlacementPublisher({
        generation: 1,
        publish,
        requestFrame: raf.request,
        cancelFrame: raf.cancel,
      })
      // No set/remove calls — flush should be a no-op.
      raf.flushFrame()
      expect(publish).not.toHaveBeenCalled()
    })

    it('does not publish on subsequent frames after an already-published snapshot', () => {
      const publisher = createPlacementPublisher({
        generation: 1,
        publish,
        requestFrame: raf.request,
        cancelFrame: raf.cancel,
      })
      publisher.set(makeView('a'))
      raf.flushFrame()
      expect(publish).toHaveBeenCalledOnce()
      publish.mockClear()

      // No more changes — another frame should not re-publish.
      raf.flushFrame()
      expect(publish).not.toHaveBeenCalled()
    })
  })

  // ── Contract 5: epoch monotonicity ──────────────────────────────────────

  describe('epoch monotonicity', () => {
    it('publishes with epoch 0 on the first frame', () => {
      const publisher = createPlacementPublisher({
        generation: 1,
        publish,
        requestFrame: raf.request,
        cancelFrame: raf.cancel,
      })
      publisher.set(makeView('a'))
      raf.flushFrame()
      expect(nthSnapshot(0).epoch).toBe(0)
    })

    it('increments epoch strictly on each successive publish', () => {
      const publisher = createPlacementPublisher({
        generation: 1,
        publish,
        requestFrame: raf.request,
        cancelFrame: raf.cancel,
      })
      publisher.set(makeView('a'))
      raf.flushFrame()
      const firstEpoch = nthSnapshot(0).epoch

      publisher.set(makeView('b'))
      raf.flushFrame()
      const secondEpoch = nthSnapshot(1).epoch

      expect(secondEpoch).toBeGreaterThan(firstEpoch)
    })
  })

  // ── Contract 6: generation pass-through ─────────────────────────────────

  describe('generation pass-through', () => {
    it('stamps every snapshot with the generation value from deps', () => {
      const publisher = createPlacementPublisher({
        generation: 42,
        publish,
        requestFrame: raf.request,
        cancelFrame: raf.cancel,
      })
      publisher.set(makeView('a'))
      raf.flushFrame()
      expect(nthSnapshot(0).generation).toBe(42)
    })

    it('stamps the same generation across multiple frames', () => {
      const publisher = createPlacementPublisher({
        generation: 7,
        publish,
        requestFrame: raf.request,
        cancelFrame: raf.cancel,
      })
      publisher.set(makeView('a'))
      raf.flushFrame()
      publisher.set(makeView('b'))
      raf.flushFrame()
      expect(snapshots.length).toBeGreaterThan(0)
      for (const snap of snapshots) {
        expect(snap.generation).toBe(7)
      }
    })
  })

  // ── Contract 7: dispose ──────────────────────────────────────────────────

  describe('dispose', () => {
    it('calls cancelFrame for the pending frame when disposed', () => {
      const publisher = createPlacementPublisher({
        generation: 1,
        publish,
        requestFrame: raf.request,
        cancelFrame: raf.cancel,
      })
      publisher.set(makeView('a'))
      expect(raf.pending).toBe(1)
      publisher.dispose()
      expect(raf.cancel).toHaveBeenCalled()
    })

    it('flushes exactly one empty snapshot when disposed, even with no prior set() calls', () => {
      // The renderer-side publisher is the single source of truth for a
      // native view's desired placement; main's reconciler is level-triggered
      // and keeps applying whatever it last received. If dispose() only
      // cancels the pending frame without publishing anything, the last
      // truthful snapshot (or "nothing was ever set") stays frozen in main
      // forever — a host toolbar view stays attached+visible after the
      // renderer that owned it is gone. Death of the source of truth must
      // itself publish as a level: empty.
      const publisher = createPlacementPublisher({
        generation: 1,
        publish,
        requestFrame: raf.request,
        cancelFrame: raf.cancel,
      })
      publisher.dispose()
      expect(publish).toHaveBeenCalledOnce()
      const snap = nthSnapshot(0)
      expect(snap.views).toEqual([])
      expect(snap.generation).toBe(1)
    })

    it('re-reads a function-form generation for the dispose flush', () => {
      let currentGen = 5
      const publisher = createPlacementPublisher({
        generation: () => currentGen,
        publish,
        requestFrame: raf.request,
        cancelFrame: raf.cancel,
      })
      currentGen = 11
      publisher.dispose()
      expect(nthSnapshot(0).generation).toBe(11)
    })

    it('stamps the dispose flush with an epoch strictly greater than any prior publish', () => {
      const publisher = createPlacementPublisher({
        generation: 1,
        publish,
        requestFrame: raf.request,
        cancelFrame: raf.cancel,
      })
      publisher.set(makeView('a'))
      raf.flushFrame()
      const priorEpoch = nthSnapshot(0).epoch

      publisher.dispose()
      expect(publish).toHaveBeenCalledTimes(2)
      expect(nthSnapshot(1).epoch).toBeGreaterThan(priorEpoch)
    })

    it('does not publish again when the pre-dispose frame callback fires after dispose', () => {
      // Capture the callback before disposal so we can call it manually,
      // simulating a rAF callback that was already queued by the platform
      // and fires despite cancelFrame having been invoked.
      let captured: (() => void) | undefined
      const customRequest = vi.fn((cb: () => void): number => {
        captured = cb
        return 1
      })
      const publisher = createPlacementPublisher({
        generation: 1,
        publish,
        requestFrame: customRequest,
        cancelFrame: vi.fn(),
      })
      publisher.set(makeView('a'))
      publisher.dispose()
      // dispose() already flushed the final empty snapshot synchronously.
      expect(publish).toHaveBeenCalledOnce()
      expect(nthSnapshot(0).views).toEqual([])

      // A stale pre-dispose frame firing afterward must not publish again.
      captured?.()
      expect(publish).toHaveBeenCalledOnce()
    })

    it('does not publish again after dispose even when set is called and a frame fires', () => {
      const publisher = createPlacementPublisher({
        generation: 1,
        publish,
        requestFrame: raf.request,
        cancelFrame: raf.cancel,
      })
      publisher.dispose()
      expect(publish).toHaveBeenCalledOnce()

      publisher.set(makeView('a'))
      raf.flushFrame()
      expect(publish).toHaveBeenCalledOnce()
    })

    it('is idempotent: a second dispose() call does not publish again', () => {
      const publisher = createPlacementPublisher({
        generation: 1,
        publish,
        requestFrame: raf.request,
        cancelFrame: raf.cancel,
      })
      publisher.dispose()
      expect(publish).toHaveBeenCalledOnce()

      publisher.dispose()
      expect(publish).toHaveBeenCalledOnce()
    })

    it('ignores set()/remove() calls after dispose without scheduling a frame', () => {
      const publisher = createPlacementPublisher({
        generation: 1,
        publish,
        requestFrame: raf.request,
        cancelFrame: raf.cancel,
      })
      publisher.dispose()
      raf.request.mockClear()

      publisher.set(makeView('a'))
      publisher.remove('a')
      expect(raf.request).not.toHaveBeenCalled()
    })
  })

  // ── Contract 8: coalescing does not span frames ──────────────────────────

  describe('cross-frame independence', () => {
    it('publishes independently on each frame when set is called between flushes', () => {
      const publisher = createPlacementPublisher({
        generation: 1,
        publish,
        requestFrame: raf.request,
        cancelFrame: raf.cancel,
      })

      // Frame 1
      publisher.set(makeView('a'))
      raf.flushFrame()

      // Frame 2
      publisher.set(makeView('b'))
      raf.flushFrame()

      expect(publish).toHaveBeenCalledTimes(2)
    })

    it('re-arms the scheduler after each frame so the next set triggers a new frame', () => {
      const publisher = createPlacementPublisher({
        generation: 1,
        publish,
        requestFrame: raf.request,
        cancelFrame: raf.cancel,
      })
      publisher.set(makeView('a'))
      raf.flushFrame()
      expect(raf.request).toHaveBeenCalledTimes(1)

      publisher.set(makeView('b'))
      // A second requestFrame call must have been made.
      expect(raf.request).toHaveBeenCalledTimes(2)
    })
  })

  // ── Contract 9: generation as a function ─────────────────────────────────

  describe('generation as a function', () => {
    it('re-reads the function on every flush so a later grant can bump the generation', () => {
      let currentGen = 3
      const publisher = createPlacementPublisher({
        generation: () => currentGen,
        publish,
        requestFrame: raf.request,
        cancelFrame: raf.cancel,
      })

      publisher.set(makeView('a'))
      raf.flushFrame()
      expect(nthSnapshot(0).generation).toBe(3)

      currentGen = 8
      publisher.set(makeView('b'))
      raf.flushFrame()
      expect(nthSnapshot(1).generation).toBe(8)
    })

    it('a constant number generation still works as before (regression guard)', () => {
      const publisher = createPlacementPublisher({
        generation: 99,
        publish,
        requestFrame: raf.request,
        cancelFrame: raf.cancel,
      })
      publisher.set(makeView('a'))
      raf.flushFrame()
      expect(nthSnapshot(0).generation).toBe(99)
    })
  })
})
