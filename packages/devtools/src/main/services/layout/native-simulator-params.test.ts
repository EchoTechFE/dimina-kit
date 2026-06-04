/**
 * NEW pure function `computeNativeSimulatorViewParams` (native-host only).
 *
 * Under native-host, a main-process `WebContentsView` (the simulator) is
 * positioned over the renderer's flex:1 PLACEHOLDER region (see
 * `src/renderer/.../simulator-panel.tsx`). The rect passed in is that panel
 * region; the WCV simply FILLS it (a plain rectangle — no native border
 * radius; the device's rounded corners live in DeviceShell CSS). To overlay it
 * faithfully the main process needs:
 *   - integer pixel `bounds` (WebContentsView.setBounds rejects fractionals),
 *     and
 *   - a `zoomFactor` to feed `webContents.setZoomFactor`.
 *
 * The real bug this catches: passing the raw fractional rect (e.g. width
 * 375.2) straight to setBounds leaves the overlay 1px off, or feeding a wrong
 * zoomFactor.
 *
 * Contract under test:
 *   computeNativeSimulatorViewParams(rect, zoomPercent) =>
 *     { bounds: Bounds, zoomFactor: number }
 *   - bounds = rect with each field Math.round'd to an integer.
 *   - zoomFactor = zoomPercent / 100.
 *   - bounds.width / bounds.height clamped to Math.max(0, round(...)).
 *   - NO borderRadius field; INNER_SCREEN_RADIUS is no longer exported.
 *
 * Pins that `computeNativeSimulatorViewParams` is exported from the layout
 * module and behaves per the contract above. The dynamic `Record` cast keeps
 * the import resolution loose at the type level.
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
) => { bounds: Bounds; zoomFactor: number }

async function loadLayout(): Promise<Record<string, unknown>> {
  return (await import('./index.js')) as unknown as Record<string, unknown>
}

describe('computeNativeSimulatorViewParams', () => {
  it('zoom 100: rounds the fractional rect to integers, zoomFactor 1', async () => {
    const layout = await loadLayout()
    const fn = layout.computeNativeSimulatorViewParams as ViewParamsFn
    const out = fn({ x: 10.4, y: 20.6, width: 375.2, height: 812.7 }, 100)
    expect(out.bounds, 'bounds must be the rect rounded to integers').toEqual({
      x: 10,
      y: 21,
      width: 375,
      height: 813,
    })
    expect(out.zoomFactor, 'zoomFactor = zoomPercent / 100').toBe(1)
  })

  it('zoom 50: zoomFactor 0.5, bounds still rounded', async () => {
    const layout = await loadLayout()
    const fn = layout.computeNativeSimulatorViewParams as ViewParamsFn
    const out = fn({ x: 0.6, y: 0.4, width: 187.5, height: 406.49 }, 50)
    expect(out.zoomFactor).toBe(0.5)
    expect(out.bounds).toEqual({ x: 1, y: 0, width: 188, height: 406 })
  })

  it('zoom 150: zoomFactor 1.5', async () => {
    const layout = await loadLayout()
    const fn = layout.computeNativeSimulatorViewParams as ViewParamsFn
    const out = fn({ x: 0, y: 0, width: 562.5, height: 1218 }, 150)
    expect(out.zoomFactor).toBe(1.5)
    expect(out.bounds).toEqual({ x: 0, y: 0, width: 563, height: 1218 })
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

  it('does not return a borderRadius field (WCV has no native radius)', async () => {
    const layout = await loadLayout()
    const fn = layout.computeNativeSimulatorViewParams as ViewParamsFn
    const out = fn({ x: 0, y: 0, width: 100, height: 200 }, 100) as Record<string, unknown>
    expect(out.borderRadius, 'borderRadius must not be returned').toBeUndefined()
  })

  it('does not export INNER_SCREEN_RADIUS', async () => {
    const layout = await loadLayout()
    expect(
      layout.INNER_SCREEN_RADIUS,
      'INNER_SCREEN_RADIUS must no longer be exported',
    ).toBeUndefined()
  })
})
