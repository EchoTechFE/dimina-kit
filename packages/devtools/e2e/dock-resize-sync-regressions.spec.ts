/**
 * PASSING regression guard (real-Electron) for THREE behaviors the v3 DockView
 * model↔view resize-sync design locks in
 * (`packages/electron-deck/src/dock-react/dock-view.tsx`).
 *
 * ── why these MUST be real-Electron + real POINTER drags ─────────────────────
 * The existing M1 specs (`dock-resize-sync.spec.ts`, the jsdom
 * `dock-view-resize-sync.test.tsx`) drive every "resize" through the production
 * `__deckApplyLayout(weights)` seam — a DIRECT `model.apply(setSizes(...))`. That
 * BYPASSES rrp's real `onLayoutChanged` callback and the basis-normalized
 * flexible-ratio write-back compare (`FLEX_RATIO_TOLERANCE`). The three behaviors
 * below live ENTIRELY on that bypassed path, so only a real pointer/keyboard
 * resize through the live rrp callback loop exercises them.
 *
 * react-resizable-panels separators are POINTER-driven (rrp v4.10 uses
 * `setPointerCapture` on the `[data-deck-resize-handle]` `Separator`), so a real
 * Playwright `mouse.down/move/up` on the handle DOES drive a genuine drag —
 * unlike the HTML5 tab drags in `dock-real-drag.spec.ts`. Every assertion here
 * that needs real layout geometry / the real rrp callback loop is marked
 * `[needs-real-electron]`.
 *
 * Default tree (see devtools `dock-layout.ts buildDefaultDockTree`):
 *   root  (row split):   [ g-sim (FIXED-px simulator) | col-main ]   seed sizes [375,1]
 *   col-main (column):   [ g-editor | g-debug ]   seed sizes [70,30], BOTH flexible
 *
 * v3 write-back rule (`handleLayoutChanged`): write the model back IFF the
 * incoming layout's FLEXIBLE-subset ratios (each normalized by their own sum)
 * differ from the model's flexible ratios (`computeFlexiblePercentages`) by more
 * than `FLEX_RATIO_TOLERANCE = 0.1` percentage points. There is NO `draggingRef`,
 * NO `LAYOUT_EPSILON`-based write-back guard, NO `gotpointercapture` listener,
 * NO `userResizePendingRef`, NO echo token — v3 deleted all of that.
 *
 * R1 — a sub-0.5% user drag PERSISTS to the model (v3 normalizes it to ~0.66pp of
 *      flexible ratio > 0.1 ⇒ written back; the old coarse 0.5pp guard that
 *      dropped it is gone).
 * R2 — a fixed-px split does NOT corrupt the flexible child's raw weight (the
 *      basis-normalized compare skips a ratio-preserving spontaneous re-measure /
 *      echo; the lone-flexible split normalizes to 100==100 ⇒ never written back ⇒
 *      raw weight preserved).
 * R3 — an away-and-back drag does NOT freeze later programmatic `setSizes` (v3 has
 *      no drag flag to get stuck; the sync effect runs on every `node.sizes`
 *      change).
 *
 * Each test PASSES on v3 and that is the correct, locked-in behavior.
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
    'dock-resize-sync-regressions',
  )
  electronApp = await _electron.launch({
    args: [appPath, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, NODE_ENV: 'test' },
  })
  mainWindow = await electronApp.firstWindow()
  await mainWindow.waitForLoadState('domcontentloaded')
  // Offscreen + blur so the spec never steals focus (real pointer drags below).
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

// ───────────────────────────── helpers ─────────────────────────────

/**
 * Read a split's live geometry: ordered direct-child pixel sizes (height for a
 * column split, width for a row split), the `data-deck-sizes` model mirror, the
 * container size along the split axis, and the center + box of the split's
 * resize handle (the rrp `Separator`). Real geometry — only meaningful in real
 * Electron.
 */
async function splitInfo(
  page: PwPage,
  splitId: string,
): Promise<{
  axis: 'w' | 'h'
  sizes: number[]
  sizesAttr: string | null
  container: number
  handle: { x: number; y: number } | null
} | null> {
  return page.evaluate((id) => {
    const split = document.querySelector(`[data-deck-split="${id}"]`)
    if (!split) return null
    const orientation = split.getAttribute('data-orientation') // 'row' | 'column'
    const axis = orientation === 'column' ? 'h' : 'w'
    const all = Array.from(split.querySelectorAll('[data-panel]')) as HTMLElement[]
    const direct = all.filter((p) => p.closest('[data-deck-split]') === split)
    const sizes = direct.map((p) => {
      const r = p.getBoundingClientRect()
      return axis === 'h' ? r.height : r.width
    })
    const groupRect = (split as HTMLElement).getBoundingClientRect()
    const handleEl = split.querySelector('[data-deck-resize-handle]') as HTMLElement | null
    let handle: { x: number; y: number } | null = null
    if (handleEl) {
      const hr = handleEl.getBoundingClientRect()
      handle = { x: hr.left + hr.width / 2, y: hr.top + hr.height / 2 }
    }
    return {
      axis: axis as 'w' | 'h',
      sizes,
      sizesAttr: split.getAttribute('data-deck-sizes'),
      container: axis === 'h' ? groupRect.height : groupRect.width,
      handle,
    }
  }, splitId)
}

/** Drive the production `__deckApplyLayout` write-back seam (a PROGRAMMATIC
 * `model.apply(setSizes(splitId, weights))`) — used only to RESET to a known
 * ratio or to drive the programmatic-sync half of R3, never to perform the
 * user-drag under test (those go through the real pointer). */
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

/** A REAL pointer drag of `splitId`'s resize handle by (dx,dy) px, with optional
 * intermediate waypoints, releasing at the final point. Mirrors a user grabbing
 * and dragging the splitter; drives rrp's pointer-capture path → the real
 * onLayoutChange/onLayoutChanged callbacks the seam bypasses. */
async function dragHandle(
  page: PwPage,
  splitId: string,
  steps: Array<{ dx: number; dy: number }>,
): Promise<{ x: number; y: number } | null> {
  const info = await splitInfo(page, splitId)
  if (!info || !info.handle) return null
  const { x, y } = info.handle
  await page.mouse.move(x, y)
  await page.mouse.down()
  for (const s of steps) {
    await page.mouse.move(x + s.dx, y + s.dy)
  }
  await page.mouse.up()
  return info.handle
}

/** Top-panel share of a split's two direct children along its axis. */
function topShare(sizes: number[]): number {
  const a = sizes[0] ?? 0
  const b = sizes[1] ?? 0
  return a + b > 0 ? a / (a + b) : 0
}

// ───────────────────── R1: sub-0.5% drag persists to the model ─────────────────────

test('[needs-real-electron] R1: a sub-0.5% real splitter drag PERSISTS to the model (v3 normalizes it above FLEX_RATIO_TOLERANCE)', async () => {
  // col-main is the column split [editor | debug], both flexible. Reset to a
  // clean 50/50 so the small drag's flexible delta is unambiguous.
  await applyLayout(mainWindow, 'col-main', [50, 50])
  await mainWindow.waitForTimeout(300)

  const before = await splitInfo(mainWindow, 'col-main')
  expect(before, 'col-main must render with a resize handle').not.toBeNull()
  expect(before!.handle, 'col-main must expose a [data-deck-resize-handle]').not.toBeNull()
  expect(before!.axis).toBe('h')
  expect(before!.sizesAttr, 'col-main reset to 50,50').toBe('50,50')
  expect(before!.sizes.length).toBe(2)

  // A drag whose container delta is UNDER 0.5% of the container along the axis —
  // i.e. the drag the OLD coarse 0.5pp guard would have dropped. 0.5% of the
  // container is `container * 0.005` px; pick a few px well under it.
  const halfPctPx = before!.container * 0.005
  const dy = 3 // observed: container ~908px → 0.5% ≈ 4.5px, so 3px is sub-0.5%
  expect(dy, `the drag (${dy}px) must be under 0.5% of the container (${halfPctPx.toFixed(2)}px) to exercise the epsilon`).toBeLessThan(halfPctPx)

  await dragHandle(mainWindow, 'col-main', [{ dx: 0, dy }])
  await mainWindow.waitForTimeout(400)

  const after = await splitInfo(mainWindow, 'col-main')

  // SANITY: the real pointer drag DID move the VISIBLE split — rrp committed the
  // small move (so this is a genuine completed user drag, not a no-op gesture).
  const topMoved = Math.abs(after!.sizes[0]! - before!.sizes[0]!)
  expect(
    topMoved,
    `the real splitter drag must visibly move the split (top panel ${before!.sizes[0]}→${after!.sizes[0]}px) — proving the gesture landed`,
  ).toBeGreaterThanOrEqual(1)

  // R1 (v3): the MODEL (and its `data-deck-sizes` mirror) must FOLLOW the drag.
  // Although the drag is sub-0.5% of the CONTAINER, v3 compares the FLEXIBLE-subset
  // RATIO: across col-main's two flexible children this ~0.33pp container move
  // normalizes to ~0.66pp of flexible ratio — above `FLEX_RATIO_TOLERANCE = 0.1`
  // — so `handleLayoutChanged` writes it back. The old coarse 0.5pp guard that
  // would have dropped this drag is gone; data-deck-sizes must change off "50,50".
  expect(
    after!.sizesAttr,
    `R1: a completed sub-0.5% user drag must be written back to the model — the visible split moved (top ${before!.sizes[0]}→${after!.sizes[0]}px) but data-deck-sizes stayed "${after!.sizesAttr}" (epsilon dropped it = the bug)`,
  ).not.toBe('50,50')
})

// NOTE — a "snap-back" variant (do the small drag, trigger an unrelated emission,
// assert the view snaps back to the pre-drag ratio) is intentionally NOT written:
// on v3 there is nothing to snap back FROM. The sub-0.5% drag is written back to
// the model (see the primary R1 assertion above), so model and view AGREE — a
// later emission has no stale model to correct toward, and any such assertion
// would pass VACUOUSLY (the view never moves on the emission) = a false-green.
// The faithful, non-vacuous R1 proof is the persisted `data-deck-sizes` mirror
// changing off "50,50", which the primary test pins.

// ───────────────────── R2: fixed-px split preserves flexible raw weight ─────────────────────

test('[needs-real-electron] R2: a fixed-px split does NOT corrupt the flexible child\'s RAW weight (v3 basis-normalized compare skips the echo)', async () => {
  // The root split is [ g-sim (FIXED-px) | col-main (flexible) ]. The model SEED
  // (dock-layout.ts) is `sizes: [375, 1]` — i.e. the flexible col-main child's
  // RAW weight is 1. The device-pin effect updates the FIXED sim slot's weight to
  // simPanelWidth via setConstraint (expected — the fixed slot's weight tracks
  // px), but it never touches the flexible child's weight, so col-main's stored
  // weight must stay the small RAW seed value (1).
  //
  // R2 (v3): the raw weight is PRESERVED. dock-view's model→view sync pushes the
  // flexible child at its container-% via `buildSetLayoutMap`; rrp echoes
  // `onLayoutChanged`; `handleLayoutChanged` then compares the incoming layout's
  // FLEXIBLE subset NORMALIZED BY ITS OWN SUM against the model's flexible ratios
  // (`computeFlexiblePercentages`, same basis). With a single flexible child
  // behind the fixed sim, that subset always normalizes to 100 and the model's
  // is also 100 ⇒ 100==100 within `FLEX_RATIO_TOLERANCE` ⇒ the echo (and any
  // ratio-preserving spontaneous re-measure) is SKIPPED ⇒ the raw seed weight 1
  // is never overwritten.
  const root = await mainWindow.evaluate(() => {
    const s = document.querySelector('[data-deck-split="root"]')
    if (!s) return null
    return {
      sizesAttr: s.getAttribute('data-deck-sizes'),
      // confirm child0 is the fixed simulator group, child1 the flexible col-main
      childPanels: Array.from(s.querySelectorAll('[data-panel]'))
        .filter((p) => p.closest('[data-deck-split]') === s)
        .map((p) => {
          const tab = p.querySelector('[data-deck-tab]')
          const nestedSplit = p.querySelector('[data-deck-split]')
          return tab?.getAttribute('data-deck-tab') ?? (nestedSplit?.getAttribute('data-deck-split') ? `split:${nestedSplit.getAttribute('data-deck-split')}` : 'unknown')
        }),
    }
  })
  expect(root, 'root split must render').not.toBeNull()
  const weights = (root!.sizesAttr ?? '').split(',').map(Number)
  expect(weights.length, 'root has two children: [fixed sim | flexible col-main]').toBe(2)

  // child1 (col-main) is the FLEXIBLE child. Its stored RAW weight must be the
  // small seed weight (1), NOT a container-derived percentage. On v3 the
  // basis-normalized compare skips the echo, so the seed weight 1 survives (it is
  // never rewritten to ~67 = 100 − sim%).
  const flexWeight = weights[1]!
  expect(
    flexWeight,
    `R2: the flexible child's stored RAW weight must stay the seed weight (≈1), not be rewritten to a container-% — got "${root!.sizesAttr}" (flex weight ${flexWeight} ≈ container-% = the corruption)`,
  ).toBeLessThan(10)
})

// NOTE — a "roundtrip" R2 variant (request raw flexible weights via the
// `__deckApplyLayout` seam, then assert they survive) is intentionally NOT
// written: the SHIPPED root split has exactly ONE flexible child (`col-main`)
// behind the fixed simulator, and a single flexible child always maps to the
// WHOLE remaining percentage regardless of its raw weight. So `buildSetLayoutMap`'s
// target equals the live layout, the setLayout-side redundant-push skip drops the
// push, no echo fires, and a seam-driven raw weight is trivially preserved — that
// variant passes VACUOUSLY (false-green). The faithful, DETERMINISTIC guard for
// R2 is the MOUNT path above: the default seed weight 1 SURVIVES the mount-time
// echo because the lone-flexible basis-normalized compare is 100==100, which the
// primary R2 test pins.
// (Driving the multi-flexible-behind-fixed shape that would stress the
// normalization across several flexible siblings is not deterministically
// reachable from the default tree via a re-dock — a split-right of the sim NESTS
// it into a new 2-child flexible split rather than adding a third root child — so
// the mount path is the faithful e2e guard.)

// ───────────────── R3: away-and-back drag does not freeze programmatic sync ─────────────────

test('[needs-real-electron] R3: a drag that returns to origin does NOT freeze later programmatic setSizes (v3 has no drag flag)', async () => {
  // v3 has NO `draggingRef` to get stuck. The model→view sync effect is keyed on
  // `node.sizes` and runs on EVERY external `setSizes`, regardless of any prior
  // drag. rrp may dedupe `onLayoutChanged` for a drag dragged AWAY and back to
  // (≈)its origin (net-zero change), but with no gate flag there is nothing left
  // armed — so a later programmatic `setSizes` syncs the visible split
  // immediately.
  await applyLayout(mainWindow, 'col-main', [50, 50])
  await mainWindow.waitForTimeout(300)

  const before = await splitInfo(mainWindow, 'col-main')
  expect(before!.handle, 'col-main must expose a handle').not.toBeNull()
  const beforeTop = before!.sizes[0]!

  // Real pointer drag AWAY (+80px) then BACK to the exact origin, then release.
  await dragHandle(mainWindow, 'col-main', [{ dx: 0, dy: 80 }, { dx: 0, dy: 0 }])
  await mainWindow.waitForTimeout(400)

  const afterDrag = await splitInfo(mainWindow, 'col-main')
  // The drag returned to origin: the visible split is back where it started.
  expect(
    Math.abs(afterDrag!.sizes[0]! - beforeTop),
    'the away-and-back drag must end at (≈)the original ratio',
  ).toBeLessThanOrEqual(4)

  // Now drive a PROGRAMMATIC setSizes to a dramatically different ratio.
  await applyLayout(mainWindow, 'col-main', [10, 90])
  await mainWindow.waitForTimeout(500)

  const afterProg = await splitInfo(mainWindow, 'col-main')
  // The model + mirror update regardless (setSizes mutates the model).
  expect(afterProg!.sizesAttr, 'the programmatic setSizes lands in the model').toBe('10,90')

  // R3 (v3): the VISIBLE split must follow the programmatic setSizes (top panel
  // shrinks to ~10% share). v3 has no drag flag to get stuck, so the away-and-back
  // drag cannot disable the sync effect — it runs on this `node.sizes` change and
  // moves the visible split.
  const share = topShare(afterProg!.sizes)
  expect(
    share,
    `R3: after an away-and-back drag the programmatic setSizes([10,90]) must move the VISIBLE split (top share should drop toward ~0.10) — got ${share.toFixed(4)} (frozen ≈0.50 = draggingRef stuck = the bug)`,
  ).toBeLessThan(0.3)
})
