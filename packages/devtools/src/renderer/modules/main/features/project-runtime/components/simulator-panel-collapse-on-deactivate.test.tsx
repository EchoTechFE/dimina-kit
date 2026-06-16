/**
 * FAILING TDD spec (red phase) for finding B1 (BLOCKER): the simulator native
 * WebContentsView is not collapsed when its kept-alive DOM tab DEACTIVATES.
 *
 * ── THE BUG ──────────────────────────────────────────────────────────────────
 * Under A3 DOM-panel keepalive, `DockView` keeps an inactive panel's body MOUNTED
 * inside a `display:none` wrapper (it no longer unmounts it). `SimulatorPanel`
 * binds its native-view placement anchor with
 *     createPlacementAnchor(el, { visible: true, followGeometry: true, publish })
 * (simulator-panel.tsx ~lines 83 / 96) WITHOUT `guardDisplayNone`. A
 * `display:none` transition is INVISIBLE to ResizeObserver, and without the guard
 * the anchor installs no IntersectionObserver and never re-measures on that
 * transition — so when the simulator tab is switched away, the wrapper goes
 * `display:none` but the native simulator WebContentsView is NEVER told to
 * collapse. It lingers as a 0-area-unaware view overlaying / intercepting the
 * now-active panel.
 *
 * ── THE CONTRACT ─────────────────────────────────────────────────────────────
 * `SimulatorPanel` must drive its native view hidden when its anchored slot goes
 * `display:none`. The mechanism the fix relies on is view-anchor's opt-in
 * `guardDisplayNone`: it (a) installs an IntersectionObserver that re-fires on a
 * display:none transition and (b) turns a zero-area measure into a
 * `{ visible:false }` publish, which `SimulatorPanel.publish` translates into a
 * COLLAPSED `setNativeSimulatorBounds({ x:0, y:0, width:0, height:0, ... })`.
 * Therefore EVERY `createPlacementAnchor` call this component makes MUST pass
 * `guardDisplayNone: true`.
 *
 * ── STRATEGY: GUARD-RAIL (not behavioral) ────────────────────────────────────
 * A true behavioral test ("toggle the wrapper to display:none → assert collapsed
 * bounds published") is NOT feasible in this jsdom suite: the guard path depends
 * on (1) `getBoundingClientRect` returning REAL geometry that changes under
 * `display:none` — jsdom always returns all-zeros and never recomputes from CSS —
 * and (2) a working `IntersectionObserver` — jsdom has none. Driving it would
 * require stubbing BOTH globals exactly as view-anchor's own unit suite does
 * (`view-anchor.test.ts`, the `guardDisplayNone` block), which would re-test
 * view-anchor's guard logic rather than SimulatorPanel's WIRING. The
 * discriminating fact for THIS component is whether it OPTS IN to the guard, so
 * we assert the option is passed (and, as a bonus, that the publish callback it
 * supplies maps a hidden placement to collapsed bounds — the downstream half of
 * the contract).
 *
 * ── HOW THIS GOES RED ON HEAD ────────────────────────────────────────────────
 * On HEAD, `createPlacementAnchor` is called withOUT `guardDisplayNone`, so the
 * `guardDisplayNone: true` assertion FAILS. After the fix (the component passes
 * `guardDisplayNone: true` at both bind sites) it passes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import type { Placement } from '@dimina-kit/view-anchor'

// ── @/shared/api mock: spy on the native-bounds channel ─────────────────────
interface NativeBounds {
  x: number
  y: number
  width: number
  height: number
  zoom?: number
}
const api = vi.hoisted(() => ({
  setNativeSimulatorBounds: vi.fn((_b: NativeBounds) => Promise.resolve()),
}))
vi.mock('@/shared/api', () => ({
  setNativeSimulatorBounds: api.setNativeSimulatorBounds,
}))

// ── view-anchor mock: capture every createPlacementAnchor invocation so we can
// inspect the options it was given AND drive its `publish` callback by hand. We
// do NOT use the real anchor here (its guard path needs real geometry + a real
// IntersectionObserver, neither of which jsdom provides — see header).
const anchorCalls = vi.hoisted(
  () => [] as Array<{
    el: HTMLElement
    opts: { visible: boolean; followGeometry?: boolean; guardDisplayNone?: boolean; publish: (p: Placement) => void }
  }>,
)
vi.mock('@dimina-kit/view-anchor', () => ({
  createPlacementAnchor: (
    el: HTMLElement,
    opts: { visible: boolean; followGeometry?: boolean; guardDisplayNone?: boolean; publish: (p: Placement) => void },
  ) => {
    anchorCalls.push({ el, opts })
    return { update: vi.fn(), dispose: vi.fn() }
  },
}))

import { SimulatorPanel } from './simulator-panel'

const DEVICE = { name: 'iPhone X', width: 375, height: 812 }

function renderPanel() {
  return render(
    <SimulatorPanel
      device={DEVICE}
      zoom={100}
      onDeviceChange={() => {}}
      onZoomChange={() => {}}
      compileStatus={{ status: 'ready', message: '' }}
      currentPage="pages/index/index"
      copied={false}
      onCopyPagePath={() => {}}
    />,
  )
}

beforeEach(() => {
  cleanup()
  anchorCalls.length = 0
  api.setNativeSimulatorBounds.mockClear()
})

describe('SimulatorPanel: collapse native view when its kept-alive slot deactivates (B1)', () => {
  // BUG (B1): the anchor is bound without `guardDisplayNone`, so a display:none
  // transition (tab deactivated under A3 keepalive) is never observed and the
  // native simulator WCV is never collapsed. The component MUST opt into the
  // guard at its bind site.
  it('binds the placement anchor with guardDisplayNone: true', () => {
    renderPanel()

    // The anchor was bound on the native-simulator region exactly once on mount.
    expect(anchorCalls.length).toBeGreaterThanOrEqual(1)
    const bind = anchorCalls[0]!
    expect(bind.el.getAttribute('data-area')).toBe('native-simulator')

    // The load-bearing assertion: the guard is opted in (fails on HEAD).
    expect(bind.opts.guardDisplayNone).toBe(true)
    // The existing geometry-follow behavior must be preserved.
    expect(bind.opts.followGeometry).toBe(true)
  })

  // CONTRACT (downstream half): a hidden placement — what the guard publishes on
  // a display:none transition — must be translated by the component's `publish`
  // into COLLAPSED native bounds (0×0), detaching the WCV. This pins the wiring
  // that makes the guard actually collapse the view rather than overlay a 0×0
  // rect over live content.
  it('publishes COLLAPSED bounds (0×0) when its anchor reports a hidden placement', () => {
    renderPanel()

    const bind = anchorCalls[0]!
    api.setNativeSimulatorBounds.mockClear()

    // Drive the anchor's publish with a HIDDEN placement (what guardDisplayNone
    // emits on a display:none transition).
    bind.opts.publish({ visible: false } as Placement)

    expect(api.setNativeSimulatorBounds).toHaveBeenCalledTimes(1)
    const arg = api.setNativeSimulatorBounds.mock.calls[0]![0]
    expect(arg.width).toBe(0)
    expect(arg.height).toBe(0)
    expect(arg.x).toBe(0)
    expect(arg.y).toBe(0)
  })
})
