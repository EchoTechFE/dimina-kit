/**
 * Contract spec: the simulator native WebContentsView re-tracks its DOM slot when
 * a dock layout mutation (e.g. flipping the simulator from the left dock to the
 * right via the "模拟器位置" toolbar) only HORIZONTALLY TRANSLATES the slot without
 * changing its size.
 *
 * ── THE BUG THIS GUARDS ──────────────────────────────────────────────────────
 * `SimulatorPanel` binds its native-view placement anchor with
 *     createPlacementAnchor(el, { visible: true, followGeometry: true, ... })
 * `followGeometry: true` installs a geometry sentinel, but that sentinel only
 * re-measures + re-publishes bounds once it is `pulse()`-ed. A pure horizontal
 * translation of the slot does NOT change its size, so ResizeObserver never fires
 * and nothing pulses the sentinel — the native simulator WCV stays at its old x/y
 * and no longer lines up with its DOM slot.
 *
 * ── THE CONTRACT ─────────────────────────────────────────────────────────────
 * `SimulatorPanel` calls `useDockLayoutEpoch()` (from
 * `@dimina-kit/electron-deck/dock-react`) and, when that epoch CHANGES, calls
 * `pulse(300)` on the handle returned by `createPlacementAnchor` (whose handle now
 * exposes `update` / `dispose` / `pulse`). A pulse on MOUNT is allowed and
 * harmless (the effect runs once for the initial epoch); the load-bearing,
 * discriminating behavior is the ADDITIONAL pulse on an epoch CHANGE.
 *
 * ── TEST STRATEGY ────────────────────────────────────────────────────────────
 * We mock `@dimina-kit/electron-deck/dock-react` so `useDockLayoutEpoch` returns a
 * test-controlled module-level value, and mock `@dimina-kit/view-anchor` so the
 * handle's `pulse` is a spy. We mount, clear the mount-time pulse, then change the
 * epoch + rerender and assert the spy fired (epoch-change pulse). The baseline test
 * rerenders with the SAME epoch (changing an unrelated prop) and asserts no pulse.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import type { Placement } from '@dimina-kit/view-anchor'

// ── @/shared/api mock: the component imports it at module load. ──────────────
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

// ── view-anchor mock: capture every createPlacementAnchor invocation and the
// handle it returns, so the test can reach the `pulse` spy. The handle carries
// update/dispose/pulse (all vi.fn). ─────────────────────────────────────────
interface AnchorHandle {
  update: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
  pulse: ReturnType<typeof vi.fn>
}
const anchorCalls = vi.hoisted(
  () => [] as Array<{
    el: HTMLElement
    opts: { visible: boolean; followGeometry?: boolean; guardDisplayNone?: boolean; publish: (p: Placement) => void }
    handle: AnchorHandle
  }>,
)
vi.mock('@dimina-kit/view-anchor', () => ({
  createPlacementAnchor: (
    el: HTMLElement,
    opts: { visible: boolean; followGeometry?: boolean; guardDisplayNone?: boolean; publish: (p: Placement) => void },
  ) => {
    const handle: AnchorHandle = { update: vi.fn(), dispose: vi.fn(), pulse: vi.fn() }
    anchorCalls.push({ el, opts, handle })
    return handle
  },
}))

// ── electron-deck dock-react mock: `useDockLayoutEpoch` returns a test-controlled
// module-level value. Tests drive an epoch change by mutating `currentEpoch` and
// rerendering. ───────────────────────────────────────────────────────────────
const epochState = vi.hoisted(() => ({ current: 0 }))
vi.mock('@dimina-kit/electron-deck/dock-react', () => ({
  useDockLayoutEpoch: () => epochState.current,
}))

import { SimulatorPanel } from './simulator-panel'

const DEVICE = { name: 'iPhone X', width: 375, height: 812 }

/** The simulator native slot's anchor (bound on the `native-simulator` region). */
function simulatorAnchor() {
  const bind = anchorCalls.find(c => c.el.getAttribute('data-area') === 'native-simulator')
  if (!bind) throw new Error('expected a placement anchor bound on data-area="native-simulator"')
  return bind
}

function panelElement(extra: Record<string, unknown> = {}) {
  return (
    <SimulatorPanel
      device={DEVICE}
      zoom={100}
      onDeviceChange={() => {}}
      onZoomChange={() => {}}
      compileStatus={{ status: 'ready', message: '' }}
      currentPage="pages/index/index"
      copied={false}
      onCopyPagePath={() => {}}
      {...extra}
    />
  )
}

beforeEach(() => {
  cleanup()
  anchorCalls.length = 0
  api.setNativeSimulatorBounds.mockClear()
  epochState.current = 0
})

describe('SimulatorPanel: pulse native-view anchor on dock layout epoch change', () => {
  // CORE: an epoch change (a dock layout mutation) must pulse the placement
  // anchor so the WCV re-tracks its slot even on a pure translation.
  it('pulses the placement anchor with 300 when the dock layout epoch changes', () => {
    epochState.current = 0
    const { rerender } = render(panelElement())

    const anchor = simulatorAnchor()
    // Drop the mount-time pulse (allowed + harmless) so the next assertion only
    // captures the epoch-CHANGE pulse.
    anchor.handle.pulse.mockClear()

    // Simulate a dock layout mutation: epoch advances, component re-renders.
    epochState.current = 1
    rerender(panelElement())

    // Load-bearing assertion: the epoch change pulses the anchor.
    expect(anchor.handle.pulse).toHaveBeenCalled()
    expect(anchor.handle.pulse).toHaveBeenCalledWith(300)
  })

  // BASELINE: a rerender with the SAME epoch (only an unrelated prop changes) must
  // NOT pulse — the pulse is keyed on the epoch, not on every render.
  it('does not pulse on a rerender when the epoch is unchanged', () => {
    epochState.current = 0
    const { rerender } = render(panelElement({ copied: false }))

    const anchor = simulatorAnchor()
    anchor.handle.pulse.mockClear()

    // Epoch unchanged; flip an unrelated prop to force a rerender.
    rerender(panelElement({ copied: true }))

    expect(anchor.handle.pulse).not.toHaveBeenCalled()
  })
})
