/**
 * REAL-ELECTRON regression guard for TWO behaviors the v3 DockView resize-sync
 * design locks in (`SplitView` in
 * `packages/electron-deck/src/dock-react/dock-view.tsx`).
 *
 * v3 has NO pointer gate. The model write-back of an `onLayoutChanged` is decided
 * by a single BASIS-NORMALIZED flexible-ratio compare: write back IFF the incoming
 * layout's flexible-subset ratios (normalized by their own sum) differ from the
 * model's flexible ratios (`computeFlexiblePercentages`) by more than
 * `FLEX_RATIO_TOLERANCE = 0.1` percentage points. There is NO `gotpointercapture`
 * listener, NO `userResizePendingRef`, NO echo token — v3 deleted all of that, so
 * a resize is honored whether it came from a pointer OR the keyboard, and a
 * ratio-preserving spontaneous re-measure is skipped BY CONSTRUCTION. These specs
 * assert MODEL state (`data-deck-sizes`) vs VISIBLE pixels, never any internal
 * flag — they are the passing guard for that design.
 *
 * WHY REAL ELECTRON (and not jsdom): rrp's resize is pointer/keyboard/geometry
 * driven. Under jsdom the Group's `getLayout()` returns `{}`, `setLayout()` is a
 * no-op, keyboard resize computes from a 0-sized container, and a pointer drag
 * never moves a real splitter — so neither the "view moved" sanity nor the
 * "model followed" assertion is observable there. Only a real Chromium renderer
 * with real layout exercises the actual `onLayoutChanged` path these tests wrap.
 *
 * Each assertion that needs real Electron is marked `[needs-real-electron]`.
 *
 * ── EXPECTED RESULT on v3 ───────────────────────────────────────────────────
 *  - R-KB:   a KEYBOARD resize moves the VISIBLE split (rrp's Arrow-key handler)
 *            AND `data-deck-sizes` follows — v3 writes it back because the
 *            flexible ratios changed; no pointer capture is needed. PASS.
 *  - R-LEAK: there is no leak to test — v3 has no gate flag to arm. A spontaneous
 *            re-measure after an away-and-back drag is ratio-preserving, so the
 *            basis-normalized compare skips it BY CONSTRUCTION. `test.fixme`,
 *            kept only as documentation (see its block below).
 */
import {
  test,
  expect,
  _electron,
  type ElectronApplication,
  type Page as PwPage,
} from '@playwright/test'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { openProjectInUI, closeProject, DEMO_APP_DIR } from './helpers'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let electronApp: ElectronApplication
let mainWindow: PwPage

const SPEC_USERDATA = 'dock-resize-sync-regressions2'

test.beforeAll(async () => {
  const appPath = path.resolve(__dirname, 'electron-entry.js')
  const cacheRoot =
    process.env.DIMINA_DEVTOOLS_DATA_DIR ??
    path.resolve(__dirname, '..', 'node_modules', '.cache', 'devtools-e2e')
  const userDataDir = path.join(cacheRoot, 'userdata', SPEC_USERDATA)
  // Clear this spec's persisted layout so a corrupt/leftover layout from a
  // previous run can NEVER mask a regression (the resize loop reads from a
  // persisted layout on remount). Documented userDataDir caching caveat.
  fs.rmSync(userDataDir, { recursive: true, force: true })

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

// ─────────────────────────── shared probes ───────────────────────────

/** Invoke the production `__deckApplyLayout` write-back seam to drive a
 * PROGRAMMATIC `model.apply(setSizes(splitId, weights))` — used only to RESET a
 * split to a known starting ratio, never as the assertion subject. */
async function applyLayout(page: PwPage, splitId: string, weights: number[]): Promise<boolean> {
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

/** The ordered live pixel sizes of a split's DIRECT rrp `[data-panel]` children
 * (measured along the split axis) + the `data-deck-sizes` model mirror. Real
 * geometry — only meaningful in real Electron. */
async function panelSizes(
  page: PwPage,
  splitId: string,
): Promise<{ axis: 'w' | 'h'; sizes: number[]; sizesAttr: string | null } | null> {
  return page.evaluate((id) => {
    const split = document.querySelector(`[data-deck-split="${id}"]`)
    if (!split) return null
    const orientation = split.getAttribute('data-orientation')
    const axis = orientation === 'column' ? 'h' : 'w'
    const all = Array.from(split.querySelectorAll('[data-panel]')) as HTMLElement[]
    const direct = all.filter((p) => p.closest('[data-deck-split]') === split)
    const sizes = direct.map((p) => {
      const r = p.getBoundingClientRect()
      return axis === 'h' ? r.height : r.width
    })
    return { axis: axis as 'w' | 'h', sizes, sizesAttr: split.getAttribute('data-deck-sizes') }
  }, splitId)
}

// ═══════════════════════════════════════════════════════════════════════════
// R-KB — a KEYBOARD resize must persist to the model
// ═══════════════════════════════════════════════════════════════════════════
//
// rrp's resize handle is `role="separator"`, `tabIndex=0`, and listens for
// `keydown` Arrow keys (verified in react-resizable-panels@4.10.0 dist: the
// keydown handler `Ge` dispatches ±5% resizes on ArrowUp/Down for a vertical
// split). A keyboard resize fires rrp's `onLayoutChanged` and changes the
// flexible-child ratios, so v3's basis-normalized compare sees a difference >
// `FLEX_RATIO_TOLERANCE` and WRITES IT BACK — no pointer capture is required
// (there is no pointer gate). The VISIBLE split moves AND the model +
// `data-deck-sizes` follow.
test('[needs-real-electron] R-KB: a keyboard (Arrow-key) resize persists to the model (data-deck-sizes follows the visible move)', async () => {
  const split = 'col-main' // column split (editor over debug) — both flexible.

  // Reset to a clean, symmetric [50,50] via the programmatic seam so the start
  // state is deterministic and the keyboard move is unambiguous.
  const reset = await applyLayout(mainWindow, split, [50, 50])
  expect(reset, 'the col-main write-back seam must be reachable to seed [50,50]').toBe(true)
  await mainWindow.waitForTimeout(400)

  const before = await panelSizes(mainWindow, split)
  expect(before, `the ${split} split must render with two flexible panels`).not.toBeNull()
  expect(before!.axis).toBe('h')
  expect(before!.sizes.length, 'col-main must have exactly two stacked panels').toBe(2)
  expect(before!.sizes[0]!, 'editor panel must have a real height').toBeGreaterThan(0)
  expect(before!.sizes[1]!, 'debug panel must have a real height').toBeGreaterThan(0)
  expect(before!.sizesAttr, 'seeded model weights must read 50,50').toBe('50,50')

  // Discover + drive the keyboard resize. rrp's separator is the element
  // carrying `data-deck-resize-handle` (we forward that attr onto rrp's
  // <Separator>). Focus it and dispatch real `keydown` ArrowUp events ON THE
  // SEPARATOR (rrp's listener reads `e.currentTarget`). For a vertical split
  // ArrowUp shrinks the top panel by 5% per press. We press several times so
  // the move is well above measurement noise.
  const kb = await mainWindow.evaluate((id) => {
    const splitEl = document.querySelector(`[data-deck-split="${id}"]`)
    if (!splitEl) return { ok: false, why: 'no split element', role: null, tabIndex: null }
    const handle = splitEl.querySelector('[data-deck-resize-handle]') as HTMLElement | null
    if (!handle) return { ok: false, why: 'no resize handle', role: null, tabIndex: null }
    const role = handle.getAttribute('role')
    const tabIndex = handle.tabIndex
    handle.focus()
    const focused = document.activeElement === handle
    // Several ArrowUp presses (shrink top). Dispatch a real keydown so rrp's
    // own document/element keydown listener runs its resize.
    for (let i = 0; i < 6; i++) {
      handle.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }),
      )
    }
    return { ok: true, why: '', role, tabIndex, focused }
  }, split)

  // Faithfulness guard: confirm we drove rrp's REAL keyboard affordance, not a
  // dead element. If rrp ever stops rendering a focusable separator, this fails
  // loudly instead of producing a vacuous green/red.
  expect(kb.ok, `keyboard resize could not be driven: ${kb.why}`).toBe(true)
  expect(kb.role, 'rrp resize handle must be role="separator" (keyboard-operable)').toBe('separator')
  expect(kb.tabIndex, 'rrp resize handle must be focusable (tabIndex 0)').toBe(0)

  await mainWindow.waitForTimeout(500)

  const after = await panelSizes(mainWindow, split)
  expect(after, 'col-main must still render after the keyboard resize').not.toBeNull()
  expect(after!.sizes.length).toBe(2)

  const topBefore = before!.sizes[0]!
  const topAfter = after!.sizes[0]!

  // SANITY [needs-real-electron]: the VISIBLE split actually moved (the top
  // panel shrank). This proves rrp's keyboard resize fired — without it the
  // model assertion below would be vacuous.
  expect(
    topAfter,
    `R-KB sanity: the visible top panel must SHRINK after ArrowUp×6 — was ${topBefore}px, now ${topAfter}px (if unchanged, rrp keyboard resize didn't fire and the test is vacuous)`,
  ).toBeLessThan(topBefore - 5)

  // R-KB (v3) [needs-real-electron]: the model must FOLLOW the visible move. The
  // keyboard resize changed the flexible ratios, so v3's basis-normalized compare
  // exceeds `FLEX_RATIO_TOLERANCE` and writes it back — no pointer needed. Assert
  // the mirror CHANGED away from the seeded 50,50.
  expect(
    after!.sizesAttr,
    `R-KB: a keyboard resize must persist to the model — data-deck-sizes must change from "50,50" (stays "50,50" on the current build = the dropped-write-back bug)`,
  ).not.toBe('50,50')

  // And the persisted weights must reflect the DIRECTION of the move: the top
  // (editor) weight must have shrunk relative to the bottom (debug) weight.
  const w = (after!.sizesAttr ?? '').split(',').map(Number)
  expect(w.length, 'data-deck-sizes must still carry two weights').toBe(2)
  expect(
    w[0]! / (w[0]! + w[1]!),
    `R-KB: persisted top weight share must drop below 0.5 after shrinking the top (got ${w.join(',')})`,
  ).toBeLessThan(0.5)
})

// ═══════════════════════════════════════════════════════════════════════════
// R-LEAK — by-construction safe in v3 (there is NO gate flag to leak)
// ═══════════════════════════════════════════════════════════════════════════
//
// This block once targeted a `userResizePendingRef` leak in an earlier (v1/v2)
// design, where a pointer-armed write-back flag could survive an away-and-back
// drag and later let a spontaneous re-measure corrupt the model. v3 DELETED that
// machinery entirely: there is NO `gotpointercapture` listener and NO
// `userResizePendingRef`. The write-back is decided solely by the basis-normalized
// flexible-ratio compare in `handleLayoutChanged`. A spontaneous re-measure (a
// fixed-px re-pin or a container resize) is RATIO-PRESERVING, so its incoming
// flexible ratios match the model's within `FLEX_RATIO_TOLERANCE` and the compare
// SKIPS the write-back BY CONSTRUCTION. There is no flag to get stuck and nothing
// to leak — so there is no R-LEAK bug to test under v3.
//
// The probe BODY below (away-and-back drag on the fixed-px split's handle →
// spontaneous device re-measure → assert the raw weights are UNCHANGED) is kept
// as DOCUMENTATION of the property v3 upholds, but it remains `test.fixme` (it
// never runs / reports): it is also non-deterministic in this harness, since the
// pieces it needs can't be driven faithfully here (measured evidence):
//   - the ROOT split's separator renders ZERO-WIDTH (the sim leaf is min===max
//     pinned ⇒ rrp gives it no hit region), so a real Playwright drag on it does
//     NOT move the split (verified: root sizes stay "423,1" through a drag); and
//   - the available re-measure triggers don't reach it: a device `<select>`
//     change is WIDTH-only and the simulator px did not change here (root stays
//     "423,1" across the change); a BrowserWindow resize does NOT re-measure the
//     renderer (the main UI renders into a FIXED-SIZE WebContentsView surface
//     whose `window.innerWidth/Height` stay 1280×948 regardless of window bounds).
// Even if both halves WERE drivable, v3 would still skip the ratio-preserving
// re-measure — so the body would pass (raw weights unchanged), which is exactly
// the by-construction guarantee. It is fixme'd rather than deleted so the intent
// and the harness-limitation evidence stay recorded.
test.fixme(
  '[needs-real-electron][by-construction-safe-in-v3] R-LEAK: an away-and-back drag does not let a later re-measure corrupt the fixed-px split weights (no gate flag exists)',
  async () => {
    // The ROOT split holds [g-sim (fixed-px) | col-main (flexible)]. A re-pin of
    // the fixed sim leaf re-measures the root → a spontaneous `onLayoutChanged`
    // whose flexible ratios are unchanged, so v3 SKIPS its write-back.
    const split = 'root'

    const rootBefore = await panelSizes(mainWindow, split)
    expect(rootBefore, 'the root split must render').not.toBeNull()
    expect(rootBefore!.sizes.length, 'root split has two children (sim | main)').toBe(2)
    const weightsBefore = rootBefore!.sizesAttr
    expect(weightsBefore, 'root split must mirror its raw weights').toBeTruthy()

    // Locate the root split's DIRECT resize handle and its midpoint.
    const handleBox = await mainWindow.evaluate(() => {
      const splitEl = document.querySelector('[data-deck-split="root"]')
      if (!splitEl) return null
      const handle = splitEl.querySelector('[data-deck-resize-handle]') as HTMLElement | null
      if (!handle || handle.closest('[data-deck-split]') !== splitEl) return null
      const r = handle.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    })
    expect(handleBox, 'the root split must expose a direct resize handle to drag').not.toBeNull()

    // REAL pointer drag AWAY then BACK to origin, released at the start (net ~0
    // → rrp dedupes `onLayoutChanged`, no write-back). In v3 there is no gate flag
    // to arm, so this drag leaves nothing behind. Real Playwright mouse input is
    // exactly what rrp listens to (pointerdown/move/up + setPointerCapture).
    const cx = handleBox!.x
    const cy = handleBox!.y
    await mainWindow.mouse.move(cx, cy)
    await mainWindow.mouse.down()
    for (const dx of [15, 30, 45, 60]) await mainWindow.mouse.move(cx + dx, cy, { steps: 4 })
    await mainWindow.waitForTimeout(50)
    for (const dx of [45, 30, 15, 0]) await mainWindow.mouse.move(cx + dx, cy, { steps: 4 })
    await mainWindow.mouse.up()
    await mainWindow.waitForTimeout(300)

    const weightsAfterDrag = (await panelSizes(mainWindow, split))!.sizesAttr

    // Trigger a SPONTANEOUS re-measure WITHOUT any user resize: change the device
    // so the fixed-px sim leaf re-pins → the root re-measures → `onLayoutChanged`.
    const changed = await mainWindow.evaluate(() => {
      const body = document.querySelector('[data-deck-panel-body="simulator"]')
      const select = body?.querySelector('select') as HTMLSelectElement | null
      if (!select || select.options.length < 2) return null
      const cur = select.selectedIndex
      const next = cur === 0 ? 1 : 0
      select.selectedIndex = next
      select.dispatchEvent(new Event('change', { bubbles: true }))
      return { from: cur, to: next, label: select.options[next]!.textContent }
    })
    expect(changed, 'the device <select> must exist with >1 option to trigger a re-measure').not.toBeNull()
    await mainWindow.waitForTimeout(600)

    const weightsAfterDevice = (await panelSizes(mainWindow, split))!.sizesAttr

    // R-LEAK (v3): a re-measure is NOT a user resize, so the root's raw weights
    // must be UNCHANGED. v3's basis-normalized compare skips the ratio-preserving
    // re-measure BY CONSTRUCTION (no gate flag to leak), so the flexible sibling's
    // raw seed weight is never overwritten by its container-%.
    expect(
      weightsAfterDevice,
      `R-LEAK: the root weights must be UNCHANGED by a re-measure (not a resize). before="${weightsBefore}" after-drag="${weightsAfterDrag}" after-device="${weightsAfterDevice}".`,
    ).toBe(weightsBefore)
  },
)
