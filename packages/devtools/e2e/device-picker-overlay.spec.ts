/**
 * The toolbar's device picker as the user meets it, on a real running project.
 *
 * The picker's list lives in its OWN overlay WebContentsView instead of the
 * workbench renderer, because the simulator is itself a native
 * WebContentsView painted over that renderer: a centred DOM dialog there is
 * sliced in half by the simulator (see `shared/view-ids.ts` — CSS z-index
 * cannot cross the native/DOM boundary). This spec pins that with the real
 * `win.contentView.children` order and the two views' real bounds, and then
 * walks the whole path: search, pick, and the device the simulator actually
 * renders afterwards.
 */
import { test, expect, useSharedProject } from './fixtures'
import type { ElectronApplication } from '@playwright/test'
import {
  DEMO_APP_DIR,
  devicePickerToolbarButton,
  openDevicePicker,
  closeDevicePicker,
  selectDeviceInPicker,
  findDevicePickerWebContentsId,
  evalInDevicePicker,
  evalInSimulator,
  pollUntil,
} from './helpers'
import { DEVICE_NAMES } from '@devicekit/devices'

interface ViewEntry {
  id: number
  url: string
  bounds: { x: number; y: number; width: number; height: number }
}

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * The child views of the window that actually hosts the simulator, in paint
 * order (last = topmost). Finding the window by its simulator child is the
 * ground truth for "the window under test" — other windows (an internal
 * devtools inspector, the project list) can outrank it in creation order.
 */
async function readSimulatorWindowViews(electronApp: ElectronApplication): Promise<ViewEntry[]> {
  return electronApp.evaluate(({ BrowserWindow }) => {
    for (const win of BrowserWindow.getAllWindows()) {
      const children = win.contentView.children as Array<{
        webContents?: { id: number; getURL(): string }
        getBounds(): { x: number; y: number; width: number; height: number }
      }>
      const entries = children
        .filter((v) => v.webContents !== undefined)
        .map((v) => ({
          id: v.webContents!.id,
          url: v.webContents!.getURL(),
          bounds: v.getBounds(),
        }))
      if (entries.some((e) => e.url.includes('simulator.html'))) return entries
    }
    return []
  })
}

function contains(outer: Rect, inner: Rect): boolean {
  return (
    outer.x <= inner.x
    && outer.y <= inner.y
    && outer.x + outer.width >= inner.x + inner.width
    && outer.y + outer.height >= inner.y + inner.height
  )
}

function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

/** The panel's own dialog box, in the overlay view's coordinates. */
async function readDialogRect(electronApp: ElectronApplication): Promise<Rect> {
  return evalInDevicePicker<Rect>(electronApp, `(() => {
    const el = document.querySelector('[role="dialog"]')
    if (!el) throw new Error('device picker dialog not rendered')
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  })()`)
}

test.describe('Device picker overlay (real Electron)', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(120_000)

  useSharedProject(test, DEMO_APP_DIR, { openTimeoutMs: 180_000 })

  test('the panel paints above the live simulator WCV, over the area the simulator covers', async ({ workbench, electronApp }) => {
    await openDevicePicker(workbench, electronApp)

    const pickerWcId = await findDevicePickerWebContentsId(electronApp)
    const views = await pollUntil(
      () => readSimulatorWindowViews(electronApp),
      (list) => list.some((v) => v.id === pickerWcId),
      15_000,
      300,
    )

    const pickerIndex = views.findIndex((v) => v.id === pickerWcId)
    const simulatorIndex = views.findIndex((v) => v.url.includes('simulator.html'))
    expect(simulatorIndex, 'simulator WCV must be live for the z-order check to mean anything').toBeGreaterThanOrEqual(0)
    // ANTI-CHEAT: the original bug rendered the dialog fine — it was just
    // ordered BELOW the simulator in this very array. Moving the panel back
    // into the workbench renderer, or attaching it under the simulator, fails
    // here.
    expect(pickerIndex).toBeGreaterThan(simulatorIndex)

    const picker = views[pickerIndex]
    const simulator = views[simulatorIndex]
    expect(contains(picker.bounds, simulator.bounds), 'the overlay must span the whole window, not dodge the simulator').toBe(true)

    // The dialog itself has to sit over the simulator's area — that overlap is
    // exactly what a workbench-renderer dialog could not survive.
    const dialog = await readDialogRect(electronApp)
    const dialogInWindow = {
      x: picker.bounds.x + dialog.x,
      y: picker.bounds.y + dialog.y,
      width: dialog.width,
      height: dialog.height,
    }
    expect(dialog.width, 'dialog must be laid out').toBeGreaterThan(0)
    expect(contains(picker.bounds, dialogInWindow), 'dialog must be fully inside its own overlay view').toBe(true)
    expect(overlapArea(dialogInWindow, simulator.bounds)).toBeGreaterThan(0)

    await closeDevicePicker(electronApp)

    // Closing withdraws the view from the window's tree; the WebContents stays
    // alive for the next open.
    const afterClose = await pollUntil(
      () => readSimulatorWindowViews(electronApp),
      (list) => !list.some((v) => v.id === pickerWcId),
      15_000,
      300,
    )
    expect(afterClose.some((v) => v.id === pickerWcId)).toBe(false)
  })

  test('searching for a device and picking it switches the running simulator', async ({ workbench, electronApp }) => {
    const before = await evalInSimulator<string | null>(
      electronApp,
      `(() => { const el = document.querySelector('device-frame'); return el ? el.getAttribute('device') : null })()`,
    )
    expect(before, 'the simulator must render a device frame before the switch').not.toBeNull()
    expect(before).not.toBe(DEVICE_NAMES.Pixel_8)

    await selectDeviceInPicker(workbench, electronApp, DEVICE_NAMES.Pixel_8)

    // The toolbar button's label IS the selected device's name.
    await expect(devicePickerToolbarButton(workbench)).toHaveText(DEVICE_NAMES.Pixel_8)

    const after = await pollUntil(
      () => evalInSimulator<string | null>(
        electronApp,
        `(() => { const el = document.querySelector('device-frame'); return el ? el.getAttribute('device') : null })()`,
      ).catch(() => null),
      (name) => name === DEVICE_NAMES.Pixel_8,
      20_000,
      500,
    )
    expect(after).toBe(DEVICE_NAMES.Pixel_8)
  })

  test('reopening the panel starts from a clean search box on the device now selected', async ({ workbench, electronApp }) => {
    await openDevicePicker(workbench, electronApp)

    const state = await evalInDevicePicker<{ query: string; current: string | null }>(electronApp, `(() => {
      const input = document.querySelector('input[role="combobox"]') || document.querySelector('input')
      const current = document.querySelector('[role="option"][data-current="true"]')
      return {
        query: input ? input.value : 'NO INPUT',
        current: current ? current.getAttribute('aria-label') : null,
      }
    })()`)

    // The overlay view is reused across opens, so a stale query from the last
    // open would silently hide most of the table.
    expect(state.query).toBe('')
    expect(state.current).toBe(DEVICE_NAMES.Pixel_8)

    await closeDevicePicker(electronApp)
  })
})
