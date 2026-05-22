/**
 * Requirement B (layout half) — the 4 bounds-computing functions must take an
 * explicit `headerHeight` parameter instead of reading a module-global
 * `HEADER_H` set via `setHeaderHeight()`.
 *
 * The real bug this catches: a host that configures `headerHeight: 72` ends
 * up with views positioned at `y: 40` because:
 *   - the main-process `setHeaderHeight()` mutates `layout.HEADER_H`, but
 *   - the renderer has its OWN hard-coded `HEADER_H = 40` in
 *     `src/renderer/shared/constants.ts` that `setHeaderHeight` can't reach,
 *   - and a process-global is fragile under multi-window / re-entrant setup.
 *
 * Target contract (per the step-1 spec):
 *   computeRightPanelBounds(contentWidth, contentHeight, simWidth, headerHeight)
 *   computeSimulatorBounds (contentWidth, contentHeight, simWidth, headerHeight)
 *   computeSettingsBounds  (contentWidth, contentHeight,           headerHeight)
 *   computePopoverBounds   (contentWidth, contentHeight,           headerHeight)
 * Each must return `y === headerHeight` and a `height` reduced by it.
 * `export let HEADER_H` and `export function setHeaderHeight` must be GONE.
 *
 * These tests are RED today: the functions ignore any 4th/3rd arg and read
 * the `HEADER_H` module-global (default 40), and `setHeaderHeight` still
 * exists. The dynamic `Record` cast lets the file compile under `tsc` while
 * the signatures are still the old arity.
 */
import { describe, it, expect } from 'vitest'

type BoundsFn = (...args: number[]) => { x: number; y: number; width: number; height: number }

async function loadLayout(): Promise<Record<string, unknown>> {
  return (await import('./index.js')) as unknown as Record<string, unknown>
}

const HH = 72 // a non-default header height; default is 40, so 72 ≠ 40 proves wiring.

describe('Requirement B: layout functions take an explicit headerHeight', () => {
  it('computeRightPanelBounds positions y at the passed headerHeight', async () => {
    const layout = await loadLayout()
    const fn = layout.computeRightPanelBounds as BoundsFn
    // contentWidth=1000, contentHeight=800, simWidth=375, headerHeight=72
    const b = fn(1000, 800, 375, HH)
    expect(b.y, 'right panel y must equal the passed headerHeight').toBe(HH)
    expect(b.height, 'right panel height must subtract the passed headerHeight').toBe(800 - HH)
  })

  it('computeSimulatorBounds positions y at the passed headerHeight', async () => {
    const layout = await loadLayout()
    const fn = layout.computeSimulatorBounds as BoundsFn
    const b = fn(1000, 800, 375, HH)
    expect(b.y).toBe(HH)
    expect(b.height).toBe(800 - HH)
  })

  it('computeSettingsBounds positions y at the passed headerHeight', async () => {
    const layout = await loadLayout()
    const fn = layout.computeSettingsBounds as BoundsFn
    // computeSettingsBounds(contentWidth, contentHeight, headerHeight)
    const b = fn(1000, 800, HH)
    expect(b.y).toBe(HH)
    expect(b.height).toBe(800 - HH)
  })

  it('computePopoverBounds positions y at the passed headerHeight', async () => {
    const layout = await loadLayout()
    const fn = layout.computePopoverBounds as BoundsFn
    // computePopoverBounds(contentWidth, contentHeight, headerHeight)
    const b = fn(1000, 800, HH)
    expect(b.y).toBe(HH)
    expect(b.height).toBe(800 - HH)
  })

  it('different headerHeight values produce different y (no hidden global)', async () => {
    const layout = await loadLayout()
    const right = layout.computeRightPanelBounds as BoundsFn
    // Two calls with different header heights in the same module instance.
    // A process-global would make the *first* call's value leak; an explicit
    // param keeps each call independent.
    const a = right(1000, 800, 375, 40)
    const b = right(1000, 800, 375, 96)
    expect(a.y).toBe(40)
    expect(b.y).toBe(96)
  })

  it('the `setHeaderHeight` process-global escape hatch is removed', async () => {
    const layout = await loadLayout()
    // The whole point of req B is to delete this. If it still exists, the
    // implementer left the global path in place.
    expect(
      layout.setHeaderHeight,
      'setHeaderHeight() must be deleted — header height is now an explicit param',
    ).toBeUndefined()
  })

  it('the mutable `HEADER_H` module export is removed', async () => {
    const layout = await loadLayout()
    // `export let HEADER_H` is the mutable global that `setHeaderHeight`
    // poked; it must go away with it.
    expect(
      layout.HEADER_H,
      'the mutable HEADER_H module export must be removed',
    ).toBeUndefined()
  })
})
