/**
 * REAL HTML5 drag-and-drop of a dock tab — the e2e counterpart to the two
 * `it.todo`s in
 * `packages/electron-deck/src/dock-react/dock-view-redock.test.tsx`:
 *
 *   it.todo('dragging a tab over the LEFT band of a group shows
 *            data-deck-drop-zone="left" and drops to split-left')
 *   it.todo('dragging a tab into the CENTER of a group shows
 *            data-deck-drop-zone="center" and drops to join')
 *
 * Those cannot run under jsdom (getBoundingClientRect returns 0, so
 * `computeDropZone` always degenerates to `center` and no zone overlay is
 * deterministic). This spec drives the REAL gesture in a real Electron renderer
 * with real layout geometry.
 *
 * ── why not `mouse.down/move/up` / `locator.dragTo` ──────────────────────────
 * DockView's tabs are `<button draggable="true">` with `onDragStart`/`onDrop`
 * HTML5 Drag-and-Drop handlers. Chromium's native DnD is driven by the OS-level
 * drag loop; Playwright's synthetic `mouse.*` does NOT emit `dragstart`/
 * `dragover`/`drop`, and `locator.dragTo` is unreliable for native HTML5 DnD in
 * an offscreen Electron window. So we synthesize the exact React-observed event
 * sequence — `dragstart` (source tab) → `dragenter`/`dragover` (target group,
 * at real client coords) → `drop` → `dragend` — with ONE shared `DataTransfer`
 * threaded through every event, exactly as the browser would. This exercises
 * the production handlers (`onDragStart` setData, `handleDragOver` →
 * `computeDropZone` → `setDropZone`, `handleDrop` → `onRedock`) end to end; the
 * only thing it does NOT reproduce is the OS drag-image / vsync animation.
 */
import {
  test,
  expect,
  _electron,
  type ElectronApplication,
  type Page as PwPage,
} from '@playwright/test'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  openProjectInUI,
  closeProject,
  DEMO_APP_DIR,
  installConsoleCollector,
  readConsoleErrors,
} from './helpers'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let electronApp: ElectronApplication
let mainWindow: PwPage

test.beforeAll(async () => {
  const appPath = path.resolve(__dirname, 'electron-entry.js')
  const userDataDir = path.join(
    process.env.DIMINA_DEVTOOLS_DATA_DIR ??
      path.resolve(__dirname, '..', 'node_modules', '.cache', 'devtools-e2e'),
    'userdata',
    'dock-real-drag',
  )
  electronApp = await _electron.launch({
    args: [appPath, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, NODE_ENV: 'test' },
  })
  mainWindow = await electronApp.firstWindow()
  await mainWindow.waitForLoadState('domcontentloaded')
  await installConsoleCollector(electronApp)
  // Offscreen + blur so the drag test never steals focus.
  await electronApp.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) { win.setPosition(-2000, -2000); win.blur() }
  })
  await openProjectInUI(mainWindow, DEMO_APP_DIR)
  await mainWindow.waitForSelector('[data-deck-group]', { timeout: 15000 })
})

test.afterAll(async () => {
  try { await closeProject(mainWindow) } catch { /* best effort */ }
  await electronApp.close()
})

/**
 * Drive a REAL HTML5 drag of the tab `draggedPanelId` onto a point inside the
 * group that currently owns `targetPanelId`, at a normalized position
 * `(fx, fy)` in [0,1] of that group's rect (e.g. {0.5,0.5}=center,
 * {0.05,0.5}=far-left band). All event dispatch happens inside the renderer so
 * the real `DataTransfer` and React synthetic handlers are exercised.
 *
 * Returns the drop-zone string that the indicator showed at the final
 * `dragover` (read from the live `data-deck-drop-zone` overlay), plus whether
 * an indicator was present at all. Captures any thrown error so the caller can
 * assert "no uncaught error".
 */
async function realDragTab(
  page: PwPage,
  draggedPanelId: string,
  targetPanelId: string,
  fx: number,
  fy: number,
): Promise<{
  ok: boolean
  zoneAtHover: string | null
  indicatorSeen: boolean
  error: string | null
}> {
  return page.evaluate(
    async ({ draggedPanelId, targetPanelId, fx, fy }) => {
      try {
        const tab = document.querySelector(
          `[data-deck-tab="${draggedPanelId}"]`,
        ) as HTMLElement | null
        if (!tab) return { ok: false, zoneAtHover: null, indicatorSeen: false, error: `no source tab ${draggedPanelId}` }

        // The group that currently owns the target panel's tab.
        const targetTab = document.querySelector(
          `[data-deck-tab="${targetPanelId}"]`,
        ) as HTMLElement | null
        if (!targetTab) return { ok: false, zoneAtHover: null, indicatorSeen: false, error: `no target tab ${targetPanelId}` }
        const group = targetTab.closest('[data-deck-group]') as HTMLElement | null
        if (!group) return { ok: false, zoneAtHover: null, indicatorSeen: false, error: `target tab ${targetPanelId} has no group` }

        const rect = group.getBoundingClientRect()
        const clientX = rect.left + rect.width * fx
        const clientY = rect.top + rect.height * fy

        // ONE DataTransfer threaded through the whole gesture, exactly as the
        // browser's native drag loop would.
        const dt = new DataTransfer()

        const fire = (
          el: Element,
          type: string,
          x: number,
          y: number,
        ): void => {
          const ev = new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            clientX: x,
            clientY: y,
          })
          // Chromium: DragEvent ctor ignores `dataTransfer` in init, so pin our
          // shared instance onto the event so the React handlers read the SAME
          // object the source wrote to.
          Object.defineProperty(ev, 'dataTransfer', { value: dt, configurable: true })
          el.dispatchEvent(ev)
        }

        // Let React commit a pending state update (setDropZone) + paint, so the
        // indicator overlay the user would SEE is actually in the DOM before we
        // read it. A single rAF + a microtask is enough for React 18's
        // synchronous-in-event-handler commit to flush to the DOM.
        const flush = (): Promise<void> =>
          new Promise((resolve) => requestAnimationFrame(() => resolve()))

        // 1) dragstart on the SOURCE tab — production onDragStart writes the
        //    panel id into the shared DataTransfer.
        const tabRect = tab.getBoundingClientRect()
        fire(tab, 'dragstart', tabRect.left + tabRect.width / 2, tabRect.top + tabRect.height / 2)

        // 2) dragenter + dragover at the real target point — production
        //    handleDragOver computes the zone from getBoundingClientRect and
        //    sets the live indicator state. Fire dragover TWICE across a frame
        //    so the React state commit is observable while the drag is still
        //    "in progress" (mirrors a real continuous hover).
        fire(group, 'dragenter', clientX, clientY)
        fire(group, 'dragover', clientX, clientY)
        await flush()
        fire(group, 'dragover', clientX, clientY)
        await flush()

        // Read the live indicator the user would SEE before releasing.
        const overlay = group.querySelector('[data-deck-drop-zone]') as HTMLElement | null
        const zoneAtHover = overlay ? overlay.getAttribute('data-deck-drop-zone') : null
        const indicatorSeen = overlay !== null

        // 3) drop + dragend — production handleDrop recovers the panel id from
        //    the shared DataTransfer and commits the re-dock.
        fire(group, 'drop', clientX, clientY)
        fire(tab, 'dragend', clientX, clientY)
        await flush()

        return { ok: true, zoneAtHover, indicatorSeen, error: null }
      } catch (e) {
        return { ok: false, zoneAtHover: null, indicatorSeen: false, error: String((e as Error)?.stack ?? e) }
      }
    },
    { draggedPanelId, targetPanelId, fx, fy },
  )
}

/**
 * A compact structural fingerprint of the live dock tree: each group with its
 * ordered panels, plus the ordered split orientations. Used to prove the tree
 * REALLY changed across a drag (not merely "still renders").
 */
async function dockFingerprint(page: PwPage): Promise<{
  groups: Array<{ id: string; panels: string[] }>
  splits: Array<{ id: string; orientation: string | null }>
  groupOf: Record<string, string>
}> {
  return page.evaluate(() => {
    const groups = Array.from(document.querySelectorAll('[data-deck-group]')).map((g) => {
      const id = g.getAttribute('data-deck-group') ?? ''
      const panels = Array.from(g.querySelectorAll('[data-deck-tab]')).map(
        (t) => t.getAttribute('data-deck-tab') ?? '',
      )
      return { id, panels }
    })
    const splits = Array.from(document.querySelectorAll('[data-deck-split]')).map((s) => ({
      id: s.getAttribute('data-deck-split') ?? '',
      orientation: s.getAttribute('data-orientation'),
    }))
    const groupOf: Record<string, string> = {}
    for (const g of groups) for (const p of g.panels) groupOf[p] = g.id
    return { groups, splits, groupOf }
  })
}

/** Native simulator WCV live bounds, as published from main. */
async function simulatorBounds(app: ElectronApplication): Promise<{ x: number; y: number; w: number; h: number } | null> {
  return app.evaluate(({ webContents, BrowserWindow }) => {
    // Find the simulator WebContentsView's bounds via the owning window's
    // contentView tree. We match the simulator by its loaded URL and read the
    // bounds off whichever WebContentsView hosts it.
    const wcs = webContents.getAllWebContents()
    const sim = wcs.find((wc) => {
      try { return wc.getURL().includes('simulator.html') } catch { return false }
    })
    if (!sim) return null
    // Walk every window's contentView subtree for the view whose webContents is
    // the simulator, and return its bounds.
    for (const win of BrowserWindow.getAllWindows()) {
      const stack = [win.contentView]
      while (stack.length) {
        const v = stack.pop() as unknown as {
          webContents?: { id: number }
          getBounds?: () => { x: number; y: number; width: number; height: number }
          children?: unknown[]
        }
        if (v?.webContents?.id === sim.id && typeof v.getBounds === 'function') {
          const b = v.getBounds()
          return { x: b.x, y: b.y, w: b.width, h: b.height }
        }
        for (const c of (v?.children ?? [])) stack.push(c)
      }
    }
    return null
  })
}

// ───────────────────────── tests ─────────────────────────

test('POINT 1+2 CENTER: real DnD of wxml tab into editor group center joins the tab group + shows center indicator', async () => {
  // Make 'editor' visible/active in its group so its body anchors the drop.
  // (wxml + editor + the debug tabs share the default tree; we drag wxml onto
  //  the group that owns editor, at its center => tab-join.)
  const before = await dockFingerprint(mainWindow)
  const wxmlGroupBefore = before.groupOf['wxml']
  const editorGroupBefore = before.groupOf['editor']
  expect(wxmlGroupBefore, 'wxml must be docked before the drag').toBeTruthy()
  expect(editorGroupBefore, 'editor must be docked before the drag').toBeTruthy()

  const r = await realDragTab(mainWindow, 'wxml', 'editor', 0.5, 0.5)
  expect(r.error, `drag must not throw: ${r.error}`).toBeNull()
  expect(r.ok, 'drag sequence must run').toBe(true)
  // POINT 2: the live indicator showed 'center' while hovering the interior.
  expect(r.indicatorSeen, 'a drop-zone indicator must appear during dragover').toBe(true)
  expect(r.zoneAtHover, 'interior hover must compute the center zone').toBe('center')

  await mainWindow.waitForTimeout(300)
  const after = await dockFingerprint(mainWindow)

  // POINT 1 (center=join): wxml now lives in the SAME group as editor, and the
  // overall fingerprint changed (it left its old group).
  expect(after.groupOf['wxml'], 'wxml must have joined editor group').toBe(after.groupOf['editor'])
  expect(JSON.stringify(after.groups)).not.toBe(JSON.stringify(before.groups))
})

test('POINT 1+2 LEFT band: real DnD of console tab onto the far-left band of editor group splits the tree (split-left) + shows left indicator', async () => {
  const before = await dockFingerprint(mainWindow)
  const consoleGroupBefore = before.groupOf['console']
  expect(consoleGroupBefore, 'console must be docked before the drag').toBeTruthy()
  const splitsBefore = before.splits.length

  // Drop console onto the far-left 5% band of the group that owns editor.
  const r = await realDragTab(mainWindow, 'console', 'editor', 0.05, 0.5)
  expect(r.error, `drag must not throw: ${r.error}`).toBeNull()
  // POINT 2: indicator showed 'left' over the left band.
  expect(r.indicatorSeen, 'a drop-zone indicator must appear during dragover').toBe(true)
  expect(r.zoneAtHover, 'far-left hover must compute the left zone').toBe('left')

  await mainWindow.waitForTimeout(300)
  const after = await dockFingerprint(mainWindow)

  // POINT 1 (left=split): a new split now exists (a row split was introduced),
  // console left its old group, and console is no longer co-located in the
  // SAME group as editor (it split out to a sibling group).
  expect(after.splits.length, 'a re-dock to an edge must introduce a new split').toBeGreaterThan(splitsBefore)
  expect(after.groupOf['console'], 'console moved out of its original group').not.toBe(consoleGroupBefore)
  expect(after.groupOf['console'], 'split-left places console in a different group than editor').not.toBe(after.groupOf['editor'])
  expect(JSON.stringify(after.splits)).not.toBe(JSON.stringify(before.splits))
})

test('POINT 3 no-op self-drop: dragging a tab onto its OWN group center does not crash or churn the tree', async () => {
  const before = await dockFingerprint(mainWindow)
  // Pick a panel and drop it onto the center of its own group (M2 no-op).
  const selfPanel = before.groups.find((g) => g.panels.length > 0)?.panels[0]
  expect(selfPanel, 'need at least one docked panel').toBeTruthy()

  const r = await realDragTab(mainWindow, selfPanel!, selfPanel!, 0.5, 0.5)
  expect(r.error, `self-drop must not throw: ${r.error}`).toBeNull()

  await mainWindow.waitForTimeout(200)
  const after = await dockFingerprint(mainWindow)
  // Tree structurally unchanged by a self-center drop (no churn).
  expect(JSON.stringify(after.groupOf), 'self-center drop must be a no-op').toBe(JSON.stringify(before.groupOf))
  // The dock is still alive.
  expect(after.groups.length).toBeGreaterThanOrEqual(1)
})

test('POINT 4 native follow: after a re-dock the simulator native WCV bounds change to track its new slot', async () => {
  const beforeBounds = await simulatorBounds(electronApp)
  expect(beforeBounds, 'simulator WCV must have live bounds before the re-dock').not.toBeNull()

  // Re-dock the simulator panel itself to the BOTTOM band of the editor group:
  // this moves its native slot to a new region, so its WCV bounds must follow.
  const r = await realDragTab(mainWindow, 'simulator', 'editor', 0.5, 0.95)
  expect(r.error, `simulator re-dock must not throw: ${r.error}`).toBeNull()
  expect(r.zoneAtHover, 'bottom band hover must compute the bottom zone').toBe('bottom')

  // Allow the view-anchor publish + main bounds apply to settle.
  await mainWindow.waitForTimeout(800)
  const afterBounds = await simulatorBounds(electronApp)
  expect(afterBounds, 'simulator WCV must still have live bounds after the re-dock').not.toBeNull()

  const moved =
    afterBounds!.x !== beforeBounds!.x ||
    afterBounds!.y !== beforeBounds!.y ||
    afterBounds!.w !== beforeBounds!.w ||
    afterBounds!.h !== beforeBounds!.h
  expect(moved, `simulator WCV bounds must change to follow its new slot (before=${JSON.stringify(beforeBounds)} after=${JSON.stringify(afterBounds)})`).toBe(true)
})

test('POINT 3 cumulative: no uncaught console errors across the whole drag sequence', async () => {
  const errors = await readConsoleErrors(electronApp)
  // Filter out unrelated, pre-existing noise (DevTools/CDP, favicon, etc.) and
  // surface only genuine page errors that a drag could plausibly cause.
  const relevant = errors.filter((e) =>
    !/favicon|DevTools|Autofill|net::ERR|Failed to load resource/i.test(e.message),
  )
  expect(
    relevant,
    `no uncaught errors during drag (saw: ${JSON.stringify(relevant.slice(0, 5))})`,
  ).toEqual([])
})
