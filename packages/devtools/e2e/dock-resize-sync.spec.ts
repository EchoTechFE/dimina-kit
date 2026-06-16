/**
 * REAL-ELECTRON proof of FINDING M1 — "model→view resize sync" — the one
 * assertion jsdom/vitest CANNOT make (see the header of
 * `packages/electron-deck/src/dock-react/dock-view-resize-sync.test.tsx`).
 *
 * THE DEFECT: dock-view.tsx `renderSplit` renders flexible children as
 * `<Panel defaultSize={pct}>`. react-resizable-panels consumes `defaultSize`
 * ONLY at mount. So after the DockView is mounted, a programmatic
 * `model.apply(setSizes(splitId, newWeights))` updates the model + the
 * `data-deck-sizes` mirror attribute but does NOT move the VISIBLE split — the
 * live rrp panel ratios stay at their mounted values. The model is supposed to
 * be the source of truth for the visible split post-mount; on HEAD it is not.
 *
 * WHY E2E (and not jsdom): rrp computes ALL geometry from real layout
 * (offsetWidth / getBoundingClientRect). Under jsdom the Group's `getLayout()`
 * returns `{}`, every Panel renders `flex-grow:50` regardless of `defaultSize`,
 * and the imperative `setLayout()` is a complete no-op — so the moved PIXELS are
 * unobservable there. Only a real Chromium renderer with real layout can prove
 * the visible panel sizes actually follow a programmatic `setSizes`.
 *
 * HOW we drive a PROGRAMMATIC setSizes without touching production source: the
 * split element exposes the PRODUCTION write-back seam `__deckApplyLayout(weights)`
 * (dock-view.tsx ~line 366) which runs `model.apply(t => setSizes(node.id, weights))`
 * — i.e. a genuine programmatic model mutation, the same engine path a host or a
 * device-change re-pin uses. We invoke it post-mount with NEW weights and assert
 * the VISIBLE panel pixel sizes follow.
 *
 * ── EXPECTED RESULT ──────────────────────────────────────────────────────────
 *  - On HEAD: the model + `data-deck-sizes` update, but the visible `[data-panel]`
 *    pixel sizes DO NOT change (rrp ignores the post-mount defaultSize change).
 *    The "visible split follows" assertions FAIL → this spec is RED, proving M1.
 *  - After the M1 fix (imperative `setLayout` on a model.sizes change): the
 *    visible panel pixel sizes follow the new ratio → this spec passes.
 *
 * Every assertion that needs REAL ELECTRON is marked `[needs-real-electron]`.
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
    'dock-resize-sync',
  )
  electronApp = await _electron.launch({
    args: [appPath, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, NODE_ENV: 'test' },
  })
  mainWindow = await electronApp.firstWindow()
  await mainWindow.waitForLoadState('domcontentloaded')
  // Offscreen + blur so the spec never steals focus.
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
 * Read the ORDERED live pixel sizes of a split's direct rrp `[data-panel]`
 * children, measured along the split's axis (height for a column split, width
 * for a row split). Real geometry — only meaningful in real Electron.
 */
async function panelSizes(
  page: PwPage,
  splitId: string,
): Promise<{ axis: 'w' | 'h'; sizes: number[]; sizesAttr: string | null } | null> {
  return page.evaluate((id) => {
    const split = document.querySelector(`[data-deck-split="${id}"]`)
    if (!split) return null
    const orientation = split.getAttribute('data-orientation') // 'row' | 'column'
    const axis = orientation === 'column' ? 'h' : 'w'
    // Direct rrp panels under THIS split's group (not nested-split descendants):
    // take only panels whose nearest ancestor split is this one.
    const all = Array.from(split.querySelectorAll('[data-panel]')) as HTMLElement[]
    const direct = all.filter((p) => p.closest('[data-deck-split]') === split)
    const sizes = direct.map((p) => {
      const r = p.getBoundingClientRect()
      return axis === 'h' ? r.height : r.width
    })
    return { axis: axis as 'w' | 'h', sizes, sizesAttr: split.getAttribute('data-deck-sizes') }
  }, splitId)
}

/** Invoke the production `__deckApplyLayout` write-back seam on a split element,
 * driving a PROGRAMMATIC `model.apply(setSizes(splitId, weights))`. */
async function applyLayout(
  page: PwPage,
  splitId: string,
  weights: number[],
): Promise<boolean> {
  return page.evaluate(
    ({ id, weights }) => {
      const split = document.querySelector(`[data-deck-split="${id}"]`) as
        | (HTMLElement & { __deckApplyLayout?: (w: number[]) => void })
        | null
      if (!split || typeof split.__deckApplyLayout !== 'function') return false
      split.__deckApplyLayout(weights)
      return true
    },
    { id: splitId, weights },
  )
}

// ─────────────────────── M1: model→view sync (core) ───────────────────────

test('[needs-real-electron] M1: a programmatic setSizes moves the VISIBLE split (col-main editor/debug)', async () => {
  // `col-main` is the default tree's column split: editor over the debug tab
  // group, both flexible, seeded [70,30]. We measure the two stacked panels'
  // live HEIGHTS, drive a programmatic setSizes to a very different ratio, and
  // assert the visible heights follow.
  const split = 'col-main'

  const before = await panelSizes(mainWindow, split)
  expect(before, `the ${split} split must render with two flexible panels`).not.toBeNull()
  expect(before!.axis).toBe('h')
  expect(before!.sizes.length, 'col-main must have exactly two stacked panels').toBe(2)
  // sanity: real geometry (non-zero heights).
  expect(before!.sizes[0]!, 'editor panel must have a real height').toBeGreaterThan(0)
  expect(before!.sizes[1]!, 'debug panel must have a real height').toBeGreaterThan(0)

  // Drive a PROGRAMMATIC setSizes to invert the ratio dramatically: shrink the
  // editor (top) to a small share, grow the debug group (bottom).
  const applied = await applyLayout(mainWindow, split, [10, 90])
  expect(applied, 'the __deckApplyLayout write-back seam must be reachable on col-main').toBe(true)
  await mainWindow.waitForTimeout(400)

  // The model + mirror update on HEAD already — assert them so a regression that
  // breaks the model write itself is also caught.
  const after = await panelSizes(mainWindow, split)
  expect(after, 'col-main must still render after setSizes').not.toBeNull()
  expect(after!.sizesAttr, 'data-deck-sizes must mirror the new model weights').toBe('10,90')

  // [needs-real-electron] THE M1 ASSERTION: the VISIBLE top (editor) panel must
  // have SHRUNK and the bottom (debug) panel must have GROWN — the live split
  // followed the programmatic setSizes. On HEAD the heights are UNCHANGED (rrp
  // ignores the post-mount defaultSize change) → this FAILS, proving M1.
  const topBefore = before!.sizes[0]!
  const topAfter = after!.sizes[0]!
  const botBefore = before!.sizes[1]!
  const botAfter = after!.sizes[1]!

  expect(
    topAfter,
    `M1: the editor (top) panel must SHRINK after setSizes([10,90]) — was ${topBefore}px, now ${topAfter}px (UNCHANGED on HEAD = the bug)`,
  ).toBeLessThan(topBefore - 5)
  expect(
    botAfter,
    `M1: the debug (bottom) panel must GROW after setSizes([10,90]) — was ${botBefore}px, now ${botAfter}px`,
  ).toBeGreaterThan(botBefore + 5)
  // And the new visible ratio must roughly match 10:90 (within tolerance for the
  // resize handle + min sizes).
  const ratioTop = topAfter / (topAfter + botAfter)
  expect(
    ratioTop,
    `M1: the visible top:bottom ratio must follow ~10:90 (got top share ${ratioTop.toFixed(3)})`,
  ).toBeLessThan(0.3)
})

// ─────────────────────── M1 regression: drag write-back (view→model) ───────────────────────

// GREEN on HEAD — this is a true regression guard (must STAY green after the
// fix): a user resize via the production `__deckApplyLayout` commit seam (the
// same path rrp's `onLayoutChanged` funnels into) must round-trip view→model.
// The fix adds model→view sync; it must NOT suppress this legitimate user write.
test('[regress] M1-regress: a user resize round-trips view→model (write-back not suppressed)', async () => {
  const split = 'col-main'

  // Restore to a known starting ratio first.
  await applyLayout(mainWindow, split, [60, 40])
  await mainWindow.waitForTimeout(300)

  const applied = await applyLayout(mainWindow, split, [40, 60])
  expect(applied).toBe(true)
  await mainWindow.waitForTimeout(400)

  const after = await panelSizes(mainWindow, split)
  // The user write-back lands in the model/mirror (true on HEAD; must stay true).
  expect(after!.sizesAttr, 'the user write-back must land in the model/mirror').toBe('40,60')
})

// RED on HEAD (post-fix invariant) — the OTHER half of M1, from the user-write
// angle: after a user write-back the VISIBLE split must SETTLE at the written
// ratio. On HEAD the model updates but the visible split is frozen at its mount
// ratio (~0.70 top share), so this is part of the same RED-until-fixed proof.
test('[needs-real-electron] M1: the visible split settles at the user-written ratio (RED on HEAD)', async () => {
  const split = 'col-main'

  await applyLayout(mainWindow, split, [40, 60])
  await mainWindow.waitForTimeout(400)

  const after = await panelSizes(mainWindow, split)
  expect(after!.sizesAttr).toBe('40,60')

  const top = after!.sizes[0]!
  const bot = after!.sizes[1]!
  const ratioTop = top / (top + bot)
  // [needs-real-electron] after the fix the visible top share is ~0.40, not the
  // frozen mount ratio.
  expect(
    ratioTop,
    `the visible split must settle ~40:60 after a user write-back (got top share ${ratioTop.toFixed(3)} — frozen at mount on HEAD)`,
  ).toBeGreaterThan(0.25)
  expect(ratioTop).toBeLessThan(0.55)
})

// ─────────────────────── M1 regression: fixed-px preserved (real pixels) ───────────────────────

test('[needs-real-electron] M1-fixed-px: a programmatic setSizes on flexible weights keeps the simulator pinned to its exact px', async () => {
  // The ROOT split pins the simulator to a fixed-px width (the simulator child
  // carries a `fixedPx` constraint). A programmatic setSizes on the root's
  // weights must leave the simulator at its EXACT pixel width — the constraint is
  // not absorbed into the flexible percentage pool. Real pixels only: jsdom can't
  // convert the px lock without a measured container (see the unit spec header).
  const simBefore = await mainWindow.evaluate(() => {
    const el = document.querySelector('[data-area="native-simulator"]')
    return el ? Math.round(el.getBoundingClientRect().width) : 0
  })
  expect(simBefore, 'the simulator region must have a real pinned width').toBeGreaterThan(0)

  // The root split holds [g-sim(fixed) | col-main(flexible)]. Drive a setSizes that
  // changes the FLEXIBLE sibling's weight; the fixed sim slot weight is carried
  // through unchanged by setSizes. We pass a full-length weights array.
  const rootInfo = await mainWindow.evaluate(() => {
    const split = document.querySelector('[data-deck-split="root"]')
    return split ? { sizes: split.getAttribute('data-deck-sizes') } : null
  })
  expect(rootInfo, 'the root split must render').not.toBeNull()
  const rootWeights = (rootInfo!.sizes ?? '').split(',').map((s) => Number(s))
  expect(rootWeights.length, 'root split has two children (sim | main)').toBe(2)

  // Keep child0 (sim) weight, change child1 (main) weight.
  const applied = await applyLayout(mainWindow, 'root', [rootWeights[0]!, rootWeights[1]! * 2])
  expect(applied).toBe(true)
  await mainWindow.waitForTimeout(400)

  // [needs-real-electron] the simulator's pinned pixel width is UNCHANGED — the
  // fixed-px constraint was not disturbed by the flexible-weights setSizes.
  const simAfter = await mainWindow.evaluate(() => {
    const el = document.querySelector('[data-area="native-simulator"]')
    return el ? Math.round(el.getBoundingClientRect().width) : 0
  })
  expect(
    Math.abs(simAfter - simBefore),
    `the simulator must stay pinned to its exact px (was ${simBefore}px, now ${simAfter}px)`,
  ).toBeLessThanOrEqual(1)
})
