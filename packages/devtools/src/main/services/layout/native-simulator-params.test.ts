/**
 * NEW pure function `computeNativeSimulatorViewParams` (native-host only).
 *
 * Under native-host, a main-process `WebContentsView` is positioned over the
 * renderer device bezel's INNER screen — a black div with `borderRadius: 36`
 * and `transform: scale(zoom/100)` (see
 * `src/renderer/.../simulator-panel.tsx`). To overlay it faithfully the main
 * process needs:
 *   - integer pixel `bounds` (WebContentsView.setBounds rejects fractionals),
 *   - a `zoomFactor` to feed `webContents.setZoomFactor`, and
 *   - a `borderRadius` that scales with the zoom so the corners stay flush
 *     with the scaled bezel.
 *
 * The real bug this catches: passing the raw fractional rect (e.g. width
 * 375.2) straight to setBounds, or hard-coding radius 36 regardless of zoom,
 * leaves the overlay 1px off and the corners square at non-100% zoom.
 *
 * Contract under test:
 *   computeNativeSimulatorViewParams(rect, zoomPercent) =>
 *     { bounds: Bounds, borderRadius: number, zoomFactor: number }
 *   - bounds = rect with each field Math.round'd to an integer.
 *   - zoomFactor = zoomPercent / 100.
 *   - borderRadius = Math.round(INNER_SCREEN_RADIUS * zoomFactor), clamped >= 0.
 *   - bounds.width / bounds.height clamped to Math.max(0, round(...)).
 *   - INNER_SCREEN_RADIUS exported === 36.
 *
 * Pins that `computeNativeSimulatorViewParams` and `INNER_SCREEN_RADIUS` are
 * exported from the layout module and behave per the contract above. The
 * dynamic `Record` cast keeps the import resolution loose at the type level.
 */
import { describe, it, expect } from 'vitest'

interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

type ViewParamsFn = (
  rect: Rect,
  zoomPercent: number,
) => { bounds: Bounds; borderRadius: number; zoomFactor: number }

async function loadLayout(): Promise<Record<string, unknown>> {
  return (await import('./index.js')) as unknown as Record<string, unknown>
}

describe('computeNativeSimulatorViewParams', () => {
  it('zoom 100: rounds the fractional rect to integers, radius 36, zoomFactor 1', async () => {
    const layout = await loadLayout()
    const fn = layout.computeNativeSimulatorViewParams as ViewParamsFn
    const out = fn({ x: 10.4, y: 20.6, width: 375.2, height: 812.7 }, 100)
    expect(out.bounds, 'bounds must be the rect rounded to integers').toEqual({
      x: 10,
      y: 21,
      width: 375,
      height: 813,
    })
    expect(out.borderRadius, 'radius at 100% must equal INNER_SCREEN_RADIUS (36)').toBe(36)
    expect(out.zoomFactor, 'zoomFactor = zoomPercent / 100').toBe(1)
  })

  it('zoom 50: radius scales to 18, zoomFactor 0.5, bounds still rounded', async () => {
    const layout = await loadLayout()
    const fn = layout.computeNativeSimulatorViewParams as ViewParamsFn
    const out = fn({ x: 0.6, y: 0.4, width: 187.5, height: 406.49 }, 50)
    expect(out.borderRadius, 'radius at 50% = round(36 * 0.5) = 18').toBe(18)
    expect(out.zoomFactor).toBe(0.5)
    expect(out.bounds).toEqual({ x: 1, y: 0, width: 188, height: 406 })
  })

  it('zoom 150: radius scales to 54, zoomFactor 1.5', async () => {
    const layout = await loadLayout()
    const fn = layout.computeNativeSimulatorViewParams as ViewParamsFn
    const out = fn({ x: 0, y: 0, width: 562.5, height: 1218 }, 150)
    expect(out.borderRadius, 'radius at 150% = round(36 * 1.5) = 54').toBe(54)
    expect(out.zoomFactor).toBe(1.5)
  })

  it('negative/zero width rect: bounds.width clamped to 0, never negative', async () => {
    const layout = await loadLayout()
    const fn = layout.computeNativeSimulatorViewParams as ViewParamsFn
    const out = fn({ x: 5, y: 5, width: -42, height: -10 }, 100)
    expect(out.bounds.width, 'width must clamp to 0, not go negative').toBe(0)
    expect(out.bounds.height, 'height must clamp to 0, not go negative').toBe(0)
    expect(out.bounds.width).toBeGreaterThanOrEqual(0)
    expect(out.bounds.height).toBeGreaterThanOrEqual(0)
  })

  it('exports INNER_SCREEN_RADIUS === 36', async () => {
    const layout = await loadLayout()
    expect(
      layout.INNER_SCREEN_RADIUS,
      'INNER_SCREEN_RADIUS must be exported and equal 36',
    ).toBe(36)
  })
})
