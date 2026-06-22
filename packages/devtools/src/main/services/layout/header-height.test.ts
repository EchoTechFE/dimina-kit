/**
 * The 4 bounds-computing functions must take an explicit `headerHeight`
 * parameter instead of reading a module-global `HEADER_H` set via
 * `setHeaderHeight()`.
 *
 * The real bug this catches: a host that configures `headerHeight: 72` ends
 * up with views positioned at `y: 40` because:
 *   - the main-process `setHeaderHeight()` mutates `layout.HEADER_H`, but
 *   - the renderer has its OWN hard-coded `HEADER_H = 40` in
 *     `src/renderer/shared/constants.ts` that `setHeaderHeight` can't reach,
 *   - and a process-global is fragile under multi-window / re-entrant setup.
 *
 * Contract:
 *   computeSettingsBounds  (contentWidth, contentHeight, headerHeight)
 *   computePopoverBounds   (contentWidth, contentHeight, headerHeight)
 * Each must return `y === headerHeight` and a `height` reduced by it.
 * `export let HEADER_H` and `export function setHeaderHeight` must be GONE.
 * (computeRightPanelBounds / computeSimulatorBounds were deleted outright with
 * the static-layout fallback — the DevTools overlay is anchor-published only —
 * so their headerHeight cases are gone with them.)
 *
 * The dynamic `Record` cast lets the file compile under `tsc` regardless of the
 * functions' exact arity.
 */
import { describe, it, expect } from 'vitest'

type BoundsFn = (...args: number[]) => { x: number; y: number; width: number; height: number }

async function loadLayout(): Promise<Record<string, unknown>> {
  return (await import('./index.js')) as unknown as Record<string, unknown>
}

const HH = 72 // a non-default header height; default is 40, so 72 ≠ 40 proves wiring.

describe('Requirement B: layout functions take an explicit headerHeight', () => {
  it('computeSettingsBounds positions y at the passed headerHeight', async () => {
    const layout = await loadLayout()
    const fn = layout.computeSettingsBounds as BoundsFn
    // computeSettingsBounds(contentWidth, contentHeight, headerHeight)
    const b = fn(1000, 800, HH)
    expect(b.y).toBe(HH)
    expect(b.height).toBe(800 - HH)
  })

  // Outside-click-to-close: computeSettingsBounds now covers the WHOLE content
  // area below the header (a transparent backdrop + the right-hand 320px
  // panel, drawn in the renderer), exactly like computePopoverBounds — NOT the
  // old right-edge 320px strip. The strip left clicks outside the panel
  // landing on a different view, so the overlay couldn't be dismissed by
  // clicking outside it.
  it('computeSettingsBounds spans the full content area below the header (no right-edge strip)', async () => {
    const layout = await loadLayout()
    const fn = layout.computeSettingsBounds as BoundsFn
    const b = fn(1000, 800, HH)
    expect(b.x).toBe(0)
    expect(b.width).toBe(1000)
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

  it('the `setHeaderHeight` process-global escape hatch is removed', async () => {
    const layout = await loadLayout()
    // Header height is an explicit param now; this process-global escape hatch
    // must not exist.
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
