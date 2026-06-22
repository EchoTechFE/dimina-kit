import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, act } from '@testing-library/react'
import { StrictMode, useCallback, useEffect, useRef } from 'react'
import { useViewAnchor, type UseViewAnchorOptions } from './react.js'

// ── ResizeObserver stub ──────────────────────────────────────────────
// The React adapter is a thin wrapper over `createViewAnchor`, so behaviour
// is observed through the injected `publish` spy + the FakeResizeObserver.
// The core publishes SYNCHRONOUSLY (no RAF defer), so a fired observer tick
// publishes immediately — there is nothing to flush.

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = []
  observed: Element[] = []
  disconnected = false
  constructor(public cb: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this)
  }
  observe(el: Element): void {
    this.observed.push(el)
  }
  unobserve(): void {
    /* unused */
  }
  disconnect(): void {
    this.disconnected = true
  }
  fire(): void {
    this.cb([], this)
  }
}

beforeEach(() => {
  FakeResizeObserver.instances = []
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** Assert an observer exists, then return it — so a skeleton no-op (no
 *  observer installed) fails as a clear behavioural assertion rather than
 *  a TypeError on a later `.fire()`. */
function firstObserver(): FakeResizeObserver {
  expect(FakeResizeObserver.instances.length).toBeGreaterThanOrEqual(1)
  return FakeResizeObserver.instances[0]!
}

function lastObserver(): FakeResizeObserver {
  expect(FakeResizeObserver.instances.length).toBeGreaterThanOrEqual(1)
  return FakeResizeObserver.instances.at(-1)!
}

// A real <div> rendered by React, but with a stubbed getBoundingClientRect.
// We stub on the element React hands us via a ref so the rect is
// deterministic in jsdom (which always returns zeros otherwise).
function stubRect(
  el: HTMLElement,
  rect: { x: number; y: number; w: number; h: number },
): void {
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
    x: rect.x,
    y: rect.y,
    left: rect.x,
    top: rect.y,
    right: rect.x + rect.w,
    bottom: rect.y + rect.h,
    width: rect.w,
    height: rect.h,
    toJSON: () => ({}),
  } as DOMRect)
}

// Test harness component: renders a <div> wired to useViewAnchor, and
// stubs its rect *before* the anchor measures it. We do the stubbing in a
// callback ref that runs before useViewAnchor's ref callback fires.
function Anchored(props: {
  options: UseViewAnchorOptions
  rect: { x: number; y: number; w: number; h: number }
  mounted?: boolean
}): React.JSX.Element | null {
  const { options, rect, mounted = true } = props
  const anchorRef = useViewAnchor(options)
  const elRef = useRef<HTMLDivElement | null>(null)
  const rectRef = useRef(rect)
  // Sync the latest rect post-commit instead of writing the ref during render
  // (react-hooks/refs). The stub is only read inside `setRef` when React hands
  // us a *new* element, which always happens after commit, so the stub timing
  // is identical to the render-time write.
  useEffect(() => {
    rectRef.current = rect
  })

  // Stable ref so a rerender doesn't tear down + re-create the anchor. An
  // unstable ref function makes React call ref(null)→ref(el) every render,
  // which would re-create the anchor and double-publish. Real consumers pass
  // the stable `anchorRef` directly; this harness only wraps it to stub the
  // element's rect for jsdom.
  const setRef = useCallback(
    (el: HTMLDivElement | null): void => {
      if (el && elRef.current !== el) {
        stubRect(el, rectRef.current)
      }
      elRef.current = el
      anchorRef(el)
    },
    [anchorRef],
  )

  if (!mounted) return null
  return <div ref={setRef} data-testid="anchored" />
}

// ── Contract 8: ref attach ⇒ createViewAnchor(el, opts) ──────────────
// Bug it catches: the adapter never wiring the ref to the core means the
// native view never gets initial bounds → never attaches.

describe('useViewAnchor — ref attach', () => {
  it('present=true: publishes the element rect once on mount', () => {
    const publish = vi.fn()
    act(() => {
      render(
        <Anchored
          options={{ present: true, publish }}
          rect={{ x: 11, y: 22, w: 333, h: 444 }}
        />,
      )
    })

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({
      x: 11,
      y: 22,
      width: 333,
      height: 444,
    })
    expect(FakeResizeObserver.instances).toHaveLength(1)
  })

  it('present=false: publishes zero on mount and does not observe', () => {
    const publish = vi.fn()
    act(() => {
      render(
        <Anchored
          options={{ present: false, publish }}
          rect={{ x: 11, y: 22, w: 333, h: 444 }}
        />,
      )
    })

    expect(publish).toHaveBeenCalledWith({ x: 0, y: 0, width: 0, height: 0 })
    expect(FakeResizeObserver.instances).toHaveLength(0)
  })
})

// ── Contract 9: ref null ⇒ publish ZERO, then dispose ───────────────
// Bug it catches: when the DOM node unmounts but the hook lives on (e.g.
// the leaf div conditionally rendered), failing to dispose leaks the RO
// and keeps publishing against a detached element.
//
// This contract ALSO requires emitting one ZERO on detach. The anchor's
// follower is a main-process WebContentsView; the host only collapses it on
// `{0,0,0,0}`. Without a ZERO the native view stays frozen at its last bounds
// and occludes content. See `react.ts`.

describe('useViewAnchor — ref null disposes', () => {
  it('detaching the DOM node publishes ZERO once, disconnects the observer, and stops publishing', () => {
    const publish = vi.fn()

    function Host(props: { mounted: boolean }): React.JSX.Element {
      return (
        <Anchored
          options={{ present: true, publish }}
          rect={{ x: 0, y: 0, w: 100, h: 100 }}
          mounted={props.mounted}
        />
      )
    }

    let rerender!: (ui: React.ReactElement) => void
    act(() => {
      ;({ rerender } = render(<Host mounted={true} />))
    })
    expect(FakeResizeObserver.instances).toHaveLength(1)
    const ro = FakeResizeObserver.instances[0]!
    publish.mockClear()

    // Unmount just the inner div (ref → null) via a prop-driven rerender; the
    // hook stays alive (only the leaf <div> is gone, exercising the null-ref
    // detach path).
    act(() => {
      rerender(<Host mounted={false} />)
    })
    expect(ro.disconnected).toBe(true)

    // A vanished anchor MUST publish exactly one ZERO so the host collapses the
    // native view — detach publishing nothing would strand the native
    // WebContentsView at its old bounds.
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({ x: 0, y: 0, width: 0, height: 0 })
    publish.mockClear()

    // After the node is gone the anchor is inert: no further publishes.
    ro.fire()
    window.dispatchEvent(new Event('resize'))
    expect(publish).not.toHaveBeenCalled()
  })
})

// ── Contract 10: opts/deps change ⇒ re-publish at current rect ───────
// Bug it catches: a tab switch toggles `display:none` (a `deps` entry) and
// the rect changes, but without re-emit the native view stays at the stale
// position → DevTools lands in the wrong place after the tab switch.

describe('useViewAnchor — opts/deps change re-publishes', () => {
  it('present change false → true re-publishes the current rect', () => {
    const publish = vi.fn()
    const { rerender } = render(
      <Anchored
        options={{ present: false, publish }}
        rect={{ x: 3, y: 4, w: 60, h: 70 }}
      />,
    )
    publish.mockClear()

    act(() => {
      rerender(
        <Anchored
          options={{ present: true, publish }}
          rect={{ x: 3, y: 4, w: 60, h: 70 }}
        />,
      )
    })

    expect(publish).toHaveBeenCalledWith({ x: 3, y: 4, width: 60, height: 70 })
  })

  it('deps change re-publishes even though present/publish are unchanged', () => {
    const publish = vi.fn()
    const base = { present: true, publish }
    const { rerender } = render(
      <Anchored
        options={{ ...base, deps: ['tab-a'] }}
        rect={{ x: 1, y: 1, w: 200, h: 200 }}
      />,
    )
    publish.mockClear()

    act(() => {
      rerender(
        <Anchored
          options={{ ...base, deps: ['tab-b'] }}
          rect={{ x: 1, y: 1, w: 200, h: 200 }}
        />,
      )
    })

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenLastCalledWith({ x: 1, y: 1, width: 200, height: 200 })
  })

  it('publish identity change routes the re-apply emit to the new callback', () => {
    const first = vi.fn()
    const second = vi.fn()
    const { rerender } = render(
      <Anchored
        options={{ present: true, publish: first }}
        rect={{ x: 0, y: 0, w: 100, h: 100 }}
      />,
    )
    first.mockClear()

    // A publish-identity change re-applies through the core's `update`, which
    // resets `lastPublished` and re-emits even on unchanged geometry — so the
    // new callback (carrying e.g. a new zoom closure) is guaranteed to fire.
    act(() => {
      rerender(
        <Anchored
          options={{ present: true, publish: second }}
          rect={{ x: 0, y: 0, w: 100, h: 100 }}
        />,
      )
    })

    expect(second).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledWith({ x: 0, y: 0, width: 100, height: 100 })
    expect(first).not.toHaveBeenCalled()
  })
})

// ── Contract 11: unmount ⇒ publish ZERO, then dispose ───────────────
// Bug it catches: a hook that does not dispose on unmount leaks the RO and
// can throw when a queued RAF fires against a torn-down IPC channel.
//
// Unmount must ALSO collapse the native view with one ZERO (same reasoning as
// Contract 9 — the follower is a main-process WebContentsView the host only
// collapses on `{0,0,0,0}`).

describe('useViewAnchor — unmount disposes', () => {
  it('unmounting the component publishes ZERO once, disconnects the observer, and never publishes after', () => {
    const publish = vi.fn()
    const { unmount } = render(
      <Anchored
        options={{ present: true, publish }}
        rect={{ x: 0, y: 0, w: 100, h: 100 }}
      />,
    )
    const ro = firstObserver()
    publish.mockClear()

    act(() => {
      unmount()
    })

    expect(ro.disconnected).toBe(true)

    // Unmount publishes exactly one ZERO to collapse the native view —
    // publishing nothing would leave the native view stranded.
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({ x: 0, y: 0, width: 0, height: 0 })
    publish.mockClear()

    // After unmount the anchor is inert: a later observer/resize tick (read
    // synchronously against `disposed`) publishes nothing — no queued frame.
    ro.fire()
    window.dispatchEvent(new Event('resize'))
    expect(publish).not.toHaveBeenCalled()
  })
})

// ── Contract 12: independent instances don't interfere ──────────────
// Bug it catches: shared module-level state (single RO / single publish
// target) would cross-wire two anchors so one's resize moves the other.

describe('useViewAnchor — independent instances', () => {
  it('two anchors observe their own element and publish independently', () => {
    const publishA = vi.fn()
    const publishB = vi.fn()

    function Pair(): React.JSX.Element {
      return (
        <>
          <Anchored
            options={{ present: true, publish: publishA }}
            rect={{ x: 0, y: 0, w: 10, h: 10 }}
          />
          <Anchored
            options={{ present: true, publish: publishB }}
            rect={{ x: 100, y: 100, w: 20, h: 20 }}
          />
        </>
      )
    }

    act(() => {
      render(<Pair />)
    })

    expect(publishA).toHaveBeenCalledWith({ x: 0, y: 0, width: 10, height: 10 })
    expect(publishB).toHaveBeenCalledWith({ x: 100, y: 100, width: 20, height: 20 })
    expect(FakeResizeObserver.instances).toHaveLength(2)

    publishA.mockClear()
    publishB.mockClear()

    // Move A's element to a NEW rect (so its tick isn't deduped), then fire
    // only A's observer → only A republishes; B is untouched (no cross-wiring).
    const aEl = FakeResizeObserver.instances[0]!.observed[0] as HTMLElement
    stubRect(aEl, { x: 1, y: 1, w: 30, h: 30 })
    FakeResizeObserver.instances[0]!.fire()
    expect(publishA).toHaveBeenCalledTimes(1)
    expect(publishA).toHaveBeenCalledWith({ x: 1, y: 1, width: 30, height: 30 })
    expect(publishB).not.toHaveBeenCalled()
  })
})

// ── Remount with present transition ──────────────
// Production coupling: the debug cell is *unmounted* when hidden and *remounted*
// when shown, so the element's mount/unmount and `options.present` flip together
// (present=false ⟺ unmounted, present=true ⟺ mounted). On "show", React commits
// the remounted element and fires the stable ref callback during the *commit*
// phase — before the `useEffect` that syncs `optsRef.current = opts` has run.
//
// Regression this guards: when the adapter syncs `optsRef.current = opts` in a
// post-commit `useEffect` (instead of during render), the ref callback that
// re-creates the anchor on remount reads a STALE `optsRef.current.present`
// (still `false` from the hidden round). It therefore calls
// `createViewAnchor(el, { present:false })`, which publishes a spurious ZERO;
// and the re-apply effect then sees the (present,publish) tuple as "unchanged"
// (true→true vs the seeded mount value) and skips, so the real rect is never
// emitted. Correct behaviour on show is: publish the real rect EXACTLY once —
// no leading ZERO, no second publish.

describe('useViewAnchor — remount with present transition', () => {
  it('show (remount + present false→true) publishes the real rect once, no ZERO, not twice', () => {
    const publish = vi.fn()

    // Host drives BOTH `mounted` and the `present` option from a single
    // `shown` flag, mirroring the production coupling (hidden ⟺ unmounted).
    // Both are passed as props and flipped via rerender inside `act` — never
    // by reassigning an outer variable during render (react-hooks/globals).
    function Host(props: { shown: boolean }): React.JSX.Element {
      return (
        <Anchored
          options={{ present: props.shown, publish }}
          rect={{ x: 17, y: 29, w: 321, h: 654 }}
          mounted={props.shown}
        />
      )
    }

    let rerender!: (ui: React.ReactElement) => void
    act(() => {
      ;({ rerender } = render(<Host shown={true} />))
    })
    // Initial mount published the real rect once; settle and clear so the
    // assertions below measure only the show transition.
    publish.mockClear()

    // Hide: element unmounts AND present flips to false. This is expected to
    // emit one collapse ZERO (detach path) — not the focus of this test.
    act(() => {
      rerender(<Host shown={false} />)
    })
    publish.mockClear()

    // Show: element remounts AND present flips back to true. The remounted
    // element's stubbed rect must be published exactly once, with no spurious
    // ZERO and no duplicate publish.
    act(() => {
      rerender(<Host shown={true} />)
    })

    expect(publish).not.toHaveBeenCalledWith({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    })
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({
      x: 17,
      y: 29,
      width: 321,
      height: 654,
    })
  })
})

// ── StrictMode resilience (regression lock) ─────────────────────────
// Not a new contract — these lock the *intended* behaviour against React's
// StrictMode, which in dev double-fires every effect's setup/cleanup
// (mount → setup → cleanup → setup) to surface unsafe lifecycle code. The
// invariant these guard is the only one a consumer can see: after a real or
// StrictMode-simulated mount, there is exactly one live anchor that (a) has
// published its rect once, (b) still follows resizes, and (c) emits exactly
// one ZERO when its element detaches.

describe('useViewAnchor — StrictMode resilience', () => {
  it('mount under StrictMode publishes the real rect exactly once with one live observer', () => {
    // Regression: a missing ref-guard / non-idempotent setup would let
    // StrictMode's attach→detach→re-attach double-publish the mount rect and
    // leave two live FakeResizeObserver connections (the first one leaked).
    const publish = vi.fn()
    act(() => {
      render(
        <StrictMode>
          <Anchored
            options={{ present: true, publish }}
            rect={{ x: 11, y: 22, w: 333, h: 444 }}
          />
        </StrictMode>,
      )
    })

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({
      x: 11,
      y: 22,
      width: 333,
      height: 444,
    })
    // StrictMode may *create* extra observers during its throwaway pass, but
    // only one may remain connected; the rest must be disconnected.
    const live = FakeResizeObserver.instances.filter((o) => !o.disconnected)
    expect(live).toHaveLength(1)
  })

  it('after StrictMode mount settles, a resize still publishes once (anchor survived remount)', () => {
    // Regression: StrictMode's simulated unmount/remount must leave a *working*
    // anchor. If the surviving handle pointed at a disposed core (or a stale
    // observer), the post-mount resize would publish zero times — the native
    // view would freeze and never follow layout after StrictMode's remount.
    const publish = vi.fn()
    act(() => {
      render(
        <StrictMode>
          <Anchored
            options={{ present: true, publish }}
            rect={{ x: 5, y: 6, w: 70, h: 80 }}
          />
        </StrictMode>,
      )
    })
    publish.mockClear()

    // The live anchor is wired to the *last* observer created during mount.
    // Move its element to a new rect so the tick isn't deduped, then fire it:
    // a surviving, working anchor re-publishes the current rect synchronously.
    act(() => {
      const liveObserver = lastObserver()
      const liveEl = liveObserver.observed[0] as HTMLElement
      stubRect(liveEl, { x: 9, y: 9, w: 71, h: 81 })
      liveObserver.fire()
    })

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({ x: 9, y: 9, width: 71, height: 81 })
  })

  it('detach under StrictMode publishes ZERO exactly once (contract 9 not amplified)', () => {
    // Regression: StrictMode's extra detach/reattach must NOT multiply the
    // single collapse ZERO. A non-idempotent collapse path would emit ZERO
    // twice (once per simulated unmount), making the host collapse/flicker the
    // native WebContentsView more than once on a single real detach.
    const publish = vi.fn()

    function Host(props: { mounted: boolean }): React.JSX.Element {
      return (
        <Anchored
          options={{ present: true, publish }}
          rect={{ x: 0, y: 0, w: 100, h: 100 }}
          mounted={props.mounted}
        />
      )
    }

    let rerender!: (ui: React.ReactElement) => void
    act(() => {
      ;({ rerender } = render(
        <StrictMode>
          <Host mounted={true} />
        </StrictMode>,
      ))
    })
    publish.mockClear()

    // Detach just the inner <div> (ref → null) while the hook stays mounted.
    act(() => {
      rerender(
        <StrictMode>
          <Host mounted={false} />
        </StrictMode>,
      )
    })

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({ x: 0, y: 0, width: 0, height: 0 })
  })
})
