/**
 * REAL pointer drag of a dock RESIZE separator.
 *
 * The existing dock-resize-sync specs drive resize through the programmatic
 * `__deckApplyLayout` seam, so they never exercise the actual grab handle. The
 * electron-deck `Separator` ships UNSTYLED (0px), so until the host skin gave it
 * a hit area (`[data-deck-resize-handle]` in design.css) a real pointer could
 * never grab it — the divider looked dead. This spec drives a real
 * `mouse.move/down/move/up` on the handle and asserts the split actually
 * resizes, pinning that the handle has a grab area and rrp commits the drag.
 */
import {
  test,
  expect,
  _electron,
  type ElectronApplication,
  type Page as PwPage,
} from '@playwright/test'
import path from 'path'
import { rmSync } from 'fs'
import { fileURLToPath } from 'url'
import { openProjectInUI, closeProject, DEMO_APP_DIR } from './helpers'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let electronApp: ElectronApplication
let mainWindow: PwPage

test.beforeAll(async () => {
  const appPath = path.resolve(__dirname, 'electron-entry.js')
  const userDataDir = path.join(
    process.env.DIMINA_DEVTOOLS_DATA_DIR ??
      path.resolve(__dirname, '..', 'node_modules', '.cache', 'devtools-e2e'),
    'userdata',
    'dock-separator-drag',
  )
  // Start from a PRISTINE default dock tree every run — the persisted layout
  // would otherwise carry a prior run's re-docks/resizes and move the splits the
  // geometry assertions target.
  rmSync(userDataDir, { recursive: true, force: true })
  electronApp = await _electron.launch({
    args: [appPath, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, NODE_ENV: 'test' },
  })
  mainWindow = await electronApp.firstWindow()
  await mainWindow.waitForLoadState('domcontentloaded')
  await electronApp.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) { win.setPosition(-2000, -2000); win.blur() }
  })
  await openProjectInUI(mainWindow, DEMO_APP_DIR)
  await mainWindow.waitForSelector('[data-deck-resize-handle]', { timeout: 15000 })
})

test.afterAll(async () => {
  try { await closeProject(mainWindow) } catch { /* best effort */ }
  await electronApp.close()
})

/** Bounding rect (in CSS px) of the group owning `panelId`. Works for tabless
 * panels (hideTab) by falling back to the panel body / native slot. */
async function groupRectOf(page: PwPage, panelId: string): Promise<{ x: number; y: number; w: number; h: number } | null> {
  return page.evaluate((pid) => {
    const marker =
      document.querySelector(`[data-deck-tab="${pid}"]`) ??
      document.querySelector(`[data-deck-panel-body="${pid}"]`) ??
      document.querySelector(`[data-deck-native-slot="${pid}"]`)
    const group = marker?.closest('[data-deck-group]') as HTMLElement | null
    if (!group) return null
    const r = group.getBoundingClientRect()
    return { x: r.left, y: r.top, w: r.width, h: r.height }
  }, panelId)
}

test('the resize handle has a real grab area (not 0px)', async () => {
  const handles = await mainWindow.evaluate(() =>
    Array.from(document.querySelectorAll('[data-deck-resize-handle]')).map((s) => {
      const r = s.getBoundingClientRect()
      return { w: Math.round(r.width), h: Math.round(r.height), aria: s.getAttribute('aria-orientation') }
    }),
  )
  expect(handles.length).toBeGreaterThan(0)
  // Every handle must have a non-zero thickness along its grab axis.
  for (const h of handles) {
    const thickness = h.aria === 'vertical' ? h.w : h.h
    expect(thickness, `handle (${h.aria}) must have a grab thickness, got ${thickness}px`).toBeGreaterThanOrEqual(4)
  }
})

test('dragging the editor/debug separator resizes the split (real pointer)', async () => {
  // The horizontal separator splits editor (top) and debug (bottom) — both
  // flexible, no native overlay over the handle.
  const hHandleCenter = (): Promise<{ cx: number; cy: number } | null> =>
    mainWindow.evaluate(() => {
      const h = document.querySelector('[data-deck-resize-handle][aria-orientation="horizontal"]') as HTMLElement | null
      if (!h) return null
      const r = h.getBoundingClientRect()
      return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 }
    })
  const editorH = async (): Promise<number> => (await groupRectOf(mainWindow, 'editor'))!.h
  const drag = async (dy: number): Promise<void> => {
    const h = await hHandleCenter()
    expect(h, 'a horizontal editor/debug separator must exist').not.toBeNull()
    await mainWindow.mouse.move(h!.cx, h!.cy)
    await mainWindow.mouse.down()
    await mainWindow.mouse.move(h!.cx, h!.cy + dy, { steps: 10 })
    await mainWindow.mouse.up()
    await mainWindow.waitForTimeout(300)
  }

  // Position-INDEPENDENT (the e2e userDataDir persists the prior run's split):
  // pull the separator toward the TOP (editor shrinks) then toward the BOTTOM
  // (editor grows) and assert the editor height swings between the two extremes —
  // proving the real-pointer drag actually moves the split.
  await drag(-260)
  const shrunk = await editorH()
  await drag(+520)
  const grown = await editorH()
  expect(
    grown - shrunk,
    `editor height must swing when the separator is dragged (shrunk ${shrunk}, grown ${grown})`,
  ).toBeGreaterThan(80)
})

test('the simulator column resizes via its left/right separator and floors at the device width (minPx)', async () => {
  // Width of the group containing the (tabless) simulator panel.
  const simWidth = (): Promise<number | null> =>
    mainWindow.evaluate(() => {
      const body = document.querySelector('[data-deck-panel-body="simulator"]')
      const g = body?.closest('[data-deck-group]') as HTMLElement | null
      return g ? Math.round(g.getBoundingClientRect().width) : null
    })
  const vHandleCenter = (): Promise<{ cx: number; cy: number } | null> =>
    mainWindow.evaluate(() => {
      const h = document.querySelector('[data-deck-resize-handle][aria-orientation="vertical"]') as HTMLElement | null
      if (!h) return null
      const r = h.getBoundingClientRect()
      return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 }
    })

  const start = await simWidth()
  expect(start, 'simulator column must have a width').not.toBeNull()
  expect(start!).toBeGreaterThan(100)

  // Drag the vertical separator RIGHT → the simulator column grows.
  const h1 = await vHandleCenter()
  expect(h1, 'a vertical simulator│right separator must exist').not.toBeNull()
  await mainWindow.mouse.move(h1!.cx, h1!.cy)
  await mainWindow.mouse.down()
  await mainWindow.mouse.move(h1!.cx + 160, h1!.cy, { steps: 10 })
  await mainWindow.mouse.up()
  await mainWindow.waitForTimeout(300)
  const wider = await simWidth()
  expect(wider!, `column should widen (start ${start}, wider ${wider})`).toBeGreaterThan(start! + 60)

  // Drag the separator FAR LEFT → the column shrinks but FLOORS at the device
  // width (the minPx constraint); it must not collapse toward 0.
  const h2 = await vHandleCenter()
  await mainWindow.mouse.move(h2!.cx, h2!.cy)
  await mainWindow.mouse.down()
  await mainWindow.mouse.move(h2!.cx - 700, h2!.cy, { steps: 14 })
  await mainWindow.mouse.up()
  await mainWindow.waitForTimeout(300)
  const floored = await simWidth()
  // It shrank from the widened state (draggable narrower)…
  expect(floored!, `column shrank from the widened state (wider ${wider}, floored ${floored})`).toBeLessThan(wider! - 40)
  // …but FLOORED at the device-width minimum — it did NOT collapse toward 0.
  expect(
    floored!,
    `column must floor at the device width, not collapse (floored ${floored})`,
  ).toBeGreaterThan(150)
})
