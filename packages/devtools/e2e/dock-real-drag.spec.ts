/**
 * REAL HTML5 drag-and-drop of a dock tab, exercising the live PanelCapabilities
 * gates with REAL layout geometry — the e2e counterpart to the geometry-driven
 * drop-zone indicator and the capability gates unit-tested (against jsdom seams)
 * in `packages/electron-deck/src/dock-react/dock-view-redock.test.tsx`.
 *
 * The devtools registry locks down EVERY panel: `simulator`/`editor` are
 * `draggable:false` (locked structural anchors — no tab, never a drag source,
 * never absorb a drop), and the five debug panels (wxml/appdata/storage/console/
 * compile) are `dropPolicy:'reorder-only'` (may ONLY reorder within their own
 * group, never join/split another). So with the real registry there is NO
 * cross-group join or edge-split gesture — these tests assert exactly that
 * contract with real geometry: the hover indicator still paints the zone
 * (presentation is geometry-only), but the drop is REJECTED and the tree does
 * not churn. Within-group reorder is covered by `dock-tab-reorder.spec.ts`.
 *
 * Geometry can't be exercised under jsdom (getBoundingClientRect returns 0, so
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
        // The SOURCE must be a real draggable tab: only a panel with a
        // `[data-deck-tab]` can begin an HTML5 drag (`hideTab`/`draggable:false`
        // structural panels render no tab and can never be a drag source).
        const tab = document.querySelector(
          `[data-deck-tab="${draggedPanelId}"]`,
        ) as HTMLElement | null
        if (!tab) return { ok: false, zoneAtHover: null, indicatorSeen: false, error: `no source tab ${draggedPanelId}` }

        // The group that currently owns the target panel. A structural target
        // (editor/simulator) has no tab — locate its group via its panel body so a
        // drag can still be aimed AT that group's region (the drop will be gated by
        // PanelCapabilities, but the gesture must reach the group to test it).
        const targetEl =
          (document.querySelector(`[data-deck-tab="${targetPanelId}"]`) as HTMLElement | null) ??
          (document.querySelector(`[data-deck-panel-body="${targetPanelId}"]`) as HTMLElement | null)
        if (!targetEl) return { ok: false, zoneAtHover: null, indicatorSeen: false, error: `no target panel ${targetPanelId}` }
        const group = targetEl.closest('[data-deck-group]') as HTMLElement | null
        if (!group) return { ok: false, zoneAtHover: null, indicatorSeen: false, error: `target panel ${targetPanelId} has no group` }

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
      // A group's panels are its draggable tabs UNION its structural bodies:
      // `hideTab` panels (simulator/editor) draw their own chrome so they carry
      // NO `[data-deck-tab]`, only a `[data-deck-panel-body]` region. Collect both
      // (de-duped, tab order first) so `groupOf` resolves every docked panel —
      // including the tabless structural ones — to its owning group.
      const seen = new Set<string>()
      const panels: string[] = []
      for (const t of g.querySelectorAll('[data-deck-tab]')) {
        const pid = t.getAttribute('data-deck-tab') ?? ''
        if (pid && !seen.has(pid)) { seen.add(pid); panels.push(pid) }
      }
      for (const b of g.querySelectorAll('[data-deck-panel-body]')) {
        const pid = b.getAttribute('data-deck-panel-body') ?? ''
        if (pid && !seen.has(pid)) { seen.add(pid); panels.push(pid) }
      }
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

test('CENTER over a locked editor group: indicator shows center, but a reorder-only debug tab dropped there is a no-op', async () => {
  // The editor group's ACTIVE panel is `editor` (draggable:false) — a locked drop
  // ANCHOR: nothing may join it. `wxml` is `dropPolicy:'reorder-only'` — it may
  // ONLY reorder within its OWN group, never join another. So a real CENTER drop
  // of wxml onto the editor group must be REJECTED (no churn), even though the
  // geometry-driven hover indicator still paints `center` (the gate is at drop
  // time, not hover time). Drives both PanelCapabilities gates with real geometry.
  const before = await dockFingerprint(mainWindow)
  const wxmlGroupBefore = before.groupOf['wxml']
  const editorGroupBefore = before.groupOf['editor']
  expect(wxmlGroupBefore, 'wxml must be docked before the drag').toBeTruthy()
  expect(editorGroupBefore, 'editor must be docked before the drag').toBeTruthy()
  expect(wxmlGroupBefore, 'wxml and editor start in DIFFERENT groups').not.toBe(editorGroupBefore)

  const r = await realDragTab(mainWindow, 'wxml', 'editor', 0.5, 0.5)
  expect(r.error, `drag must not throw: ${r.error}`).toBeNull()
  expect(r.ok, 'drag sequence must run').toBe(true)
  // The live indicator paints `center` while hovering the interior (presentation
  // is geometry-only; capability gating happens at drop).
  expect(r.indicatorSeen, 'a drop-zone indicator must appear during dragover').toBe(true)
  expect(r.zoneAtHover, 'interior hover must compute the center zone').toBe('center')

  await mainWindow.waitForTimeout(300)
  const after = await dockFingerprint(mainWindow)

  // The drop is rejected on BOTH gates: wxml stays in its own group, never joins
  // editor, and the overall group membership is unchanged.
  expect(after.groupOf['wxml'], 'wxml stays in its own group').toBe(wxmlGroupBefore)
  expect(after.groupOf['wxml'], 'wxml never joins the locked editor group').not.toBe(after.groupOf['editor'])
  expect(after.groupOf, 'a rejected center drop must not churn the tree').toEqual(before.groupOf)
})

test('LEFT band over a locked editor group: indicator shows left, but a reorder-only debug tab edge-dropped there introduces no split', async () => {
  // `console` is `dropPolicy:'reorder-only'` — it may NEVER edge-split out of its
  // group. The editor group is also a locked anchor (active `editor` is
  // draggable:false). So an edge (far-left band) drop of console onto the editor
  // group is REJECTED: no new split, console stays put. The hover indicator still
  // paints `left` (geometry-only presentation).
  const before = await dockFingerprint(mainWindow)
  const consoleGroupBefore = before.groupOf['console']
  expect(consoleGroupBefore, 'console must be docked before the drag').toBeTruthy()
  const splitsBefore = before.splits.length

  // Drop console onto the far-left 5% band of the group that owns editor.
  const r = await realDragTab(mainWindow, 'console', 'editor', 0.05, 0.5)
  expect(r.error, `drag must not throw: ${r.error}`).toBeNull()
  // The indicator paints `left` over the left band (presentation is geometry-only).
  expect(r.indicatorSeen, 'a drop-zone indicator must appear during dragover').toBe(true)
  expect(r.zoneAtHover, 'far-left hover must compute the left zone').toBe('left')

  await mainWindow.waitForTimeout(300)
  const after = await dockFingerprint(mainWindow)

  // The edge drop is rejected: no split is introduced and console stays in its
  // original group (it never tears out toward the editor region).
  expect(after.splits.length, 'a rejected edge drop must NOT introduce a split').toBe(splitsBefore)
  expect(after.groupOf['console'], 'console stays in its original group').toBe(consoleGroupBefore)
  expect(after.groupOf['console'], 'console never splits next to the locked editor').not.toBe(after.groupOf['editor'])
  expect(after.groupOf, 'a rejected edge drop must not churn the tree').toEqual(before.groupOf)
})

test('self-drop center of a reorder-only debug tab stays WITHIN its own group (never leaves, never crashes)', async () => {
  const before = await dockFingerprint(mainWindow)
  // Pick a real DRAGGABLE source: a debug tab (the source must own a
  // `[data-deck-tab]`). The structural simulator/editor panels are tabless
  // (hideTab) and draggable:false, so they can never be a drag source.
  const selfPanel = 'wxml'
  const selfGroupBefore = before.groupOf[selfPanel]
  expect(selfGroupBefore, `${selfPanel} must be docked before the drag`).toBeTruthy()
  const memberIdsBefore = [...(before.groups.find((g) => g.id === selfGroupBefore)?.panels ?? [])].sort()

  // A center drop onto its OWN group is the one motion `reorder-only` permits — it
  // REORDERS within the group (it never leaves). The exact resulting index is
  // pointer-derived; the invariant is: same group, same membership set, no crash.
  const r = await realDragTab(mainWindow, selfPanel, selfPanel, 0.5, 0.5)
  expect(r.error, `self-drop must not throw: ${r.error}`).toBeNull()

  await mainWindow.waitForTimeout(200)
  const after = await dockFingerprint(mainWindow)
  // The panel stays in its own group (reorder-only never tears out).
  expect(after.groupOf[selfPanel], 'self-center drop keeps the panel in its own group').toBe(selfGroupBefore)
  // Group membership (as a SET) is unchanged — only the within-group ORDER may shift.
  const memberIdsAfter = [...(after.groups.find((g) => g.id === selfGroupBefore)?.panels ?? [])].sort()
  expect(memberIdsAfter, 'self-center drop preserves the group membership set').toEqual(memberIdsBefore)
  // No panel migrated between groups, and the dock is still alive.
  expect(after.groupOf, 'no panel changed groups').toEqual(before.groupOf)
  expect(after.groups.length).toBeGreaterThanOrEqual(1)
})

test('native anchor: the simulator (draggable:false) cannot be torn out — a drag attempt is a no-op and its WCV bounds stay put', async () => {
  // The simulator is `draggable:false` + `hideTab:true`: it renders NO tab, so it
  // can never be a drag SOURCE, and it is a locked drop ANCHOR (nothing may
  // re-dock against it). Its native WebContentsView is pinned to its slot; only a
  // resize/preset change (exercised by the dock-resize/separator specs) moves it.
  // Here we prove the negative: attempting to drag the simulator is a no-op and
  // its live WCV bounds are unchanged.
  const beforeBounds = await simulatorBounds(electronApp)
  expect(beforeBounds, 'simulator WCV must have live bounds').not.toBeNull()
  const before = await dockFingerprint(mainWindow)
  const simGroupBefore = before.groupOf['simulator']
  expect(simGroupBefore, 'simulator must be docked').toBeTruthy()

  // The simulator has no `[data-deck-tab]`, so realDragTab cannot pick it up — the
  // gesture fails to even start, which IS the contract (a draggable:false panel
  // can never be lifted).
  const r = await realDragTab(mainWindow, 'simulator', 'editor', 0.5, 0.95)
  expect(r.ok, 'a draggable:false panel cannot start a drag (no source tab)').toBe(false)
  expect(r.error, 'the absent tab is the reason the drag never starts').toMatch(/no source tab simulator/)

  await mainWindow.waitForTimeout(300)
  const after = await dockFingerprint(mainWindow)
  // The simulator stays in its group and the tree is unchanged.
  expect(after.groupOf['simulator'], 'simulator never leaves its group').toBe(simGroupBefore)
  expect(after.groupOf, 'a failed simulator drag must not churn the tree').toEqual(before.groupOf)

  // Its native WCV bounds are still live and unchanged (no re-dock happened).
  const afterBounds = await simulatorBounds(electronApp)
  expect(afterBounds, 'simulator WCV must still have live bounds').not.toBeNull()
  expect(afterBounds, `simulator WCV bounds must be unchanged (before=${JSON.stringify(beforeBounds)} after=${JSON.stringify(afterBounds)})`).toEqual(beforeBounds)
})

test('cumulative: no uncaught console errors across the whole drag sequence', async () => {
  const errors = await readConsoleErrors(electronApp)
  // Filter out unrelated, pre-existing noise (DevTools/CDP, favicon, etc.) and
  // surface only genuine page errors that a drag could plausibly cause. The
  // 'editor' dock body lazily attaches the embedded A2 workbench WebContentsView;
  // that third-party VS Code bundle emits its own startup warnings (extension-host
  // iframe sandbox notes, permissions-policy) from its 127.0.0.1 COI origin —
  // unrelated to the drag gesture, so filter by their workbench origin/source.
  const relevant = errors.filter((e) => {
    if (/favicon|DevTools|Autofill|net::ERR|Failed to load resource/i.test(e.message)) return false
    if (/ExtensionHost|a2-spike|local-network-access|allow-scripts and allow-same-origin/i.test(
      `${e.message} ${e.source} ${e.url}`,
    )) return false
    if (/json\.schemas is not a registered configuration|Unable to resolve nonexistent file '\/workspace'/i.test(e.message)) return false
    return true
  })
  expect(
    relevant,
    `no uncaught errors during drag (saw: ${JSON.stringify(relevant.slice(0, 5))})`,
  ).toEqual([])
})
