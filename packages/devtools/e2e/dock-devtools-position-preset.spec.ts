/**
 * REAL-ELECTRON proof of Bug #3 — "cold-mount px-conversion collapse" — a
 * defect only observable with real react-resizable-panels (rrp) layout, not
 * jsdom (see the header of `dock-view-robustness.test.tsx` for the sibling
 * Bug #2, and `split-sizing.test.ts` for the pure-arithmetic side of this fix).
 *
 * THE DEFECT: the toolbar's "调试器位置" preset toggle
 * (`layout-toolbar-devtools-*`) rebuilds the WHOLE dock tree via
 * `buildPresetDockTree` on every click. `belowSimulator` is the one preset
 * whose `minPx`-pinned root child (`col-sim`) is itself a NESTED split
 * (simulator + debug), unlike `inEditor`/`rightOfSimulator` whose pinned root
 * child is a plain leaf tab group (`g-sim`). `SplitView`'s
 * `<Group key={node.children.length}>` (dock-react/split-view.tsx) forces a
 * cold Group remount whenever the root's child COUNT changes (the Bug #2
 * guard) — and switching FROM `rightOfSimulator` (3 root children) INTO
 * `belowSimulator` (2) is exactly such a count change. On that cold remount,
 * rrp's own mount-time px→percentage conversion for the nested-split pinned
 * child lands on a degenerate ratio (empirically: the pinned child grabbing
 * ~99% while the lone flexible sibling — the editor — collapses to rrp's
 * floor, a few px wide) and nothing thereafter re-measures to correct it.
 *
 * WHY E2E (and not jsdom): rrp computes ALL geometry from real layout
 * (getBoundingClientRect). Under jsdom the Group's `getLayout()` returns `{}`
 * and the imperative `setLayout()` is a no-op, so this cold-mount conversion
 * is entirely unobservable there — see `dock-view-robustness.test.tsx`'s
 * header for the same limitation on the sibling Bug #2.
 *
 * ── EXPECTED RESULT ──────────────────────────────────────────────────────
 *  - Before the fix: the editor region's rendered width collapses to a few
 *    px after `rightOfSimulator -> belowSimulator` — this spec is RED.
 *  - After the fix (`buildSetLayoutMap`'s `measured` param + `SplitView`
 *    deriving a fresh-remount's fixed-child target percentage from a REAL
 *    container measurement instead of trusting rrp's cold-mount live value):
 *    the editor stays at its intended ~2/3-of-container share.
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
    'dock-devtools-position-preset',
  )
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
  await mainWindow.waitForSelector('[data-deck-group]', { timeout: 15000 })
})

test.afterAll(async () => {
  try { await closeProject(mainWindow) } catch { /* best effort */ }
  await electronApp.close()
})

async function clickPreset(
  page: PwPage,
  id: 'inEditor' | 'belowSimulator' | 'rightOfSimulator',
): Promise<void> {
  await page.click(`[data-testid="layout-toolbar-devtools-${id}"]`)
  await page.waitForTimeout(500)
}

async function editorWidth(page: PwPage): Promise<number> {
  return page.evaluate(() => {
    const el = document.querySelector('[data-area="editor"]')
    return el ? Math.round(el.getBoundingClientRect().width) : -1
  })
}

// A collapsed editor lands at rrp's flexible floor (a handful of px); a
// healthy one is several hundred px in the default test window. 50px is
// comfortably above the floor and comfortably below any healthy width.
const MIN_HEALTHY_EDITOR_WIDTH = 50

test('[needs-real-electron] Bug #3: rightOfSimulator -> belowSimulator does not collapse the editor width', async () => {
  await clickPreset(mainWindow, 'rightOfSimulator')
  await clickPreset(mainWindow, 'belowSimulator')

  const w = await editorWidth(mainWindow)
  expect(
    w,
    `editor width after rightOfSimulator->belowSimulator must stay healthy (got ${w}px — a collapse to a few px is Bug #3)`,
  ).toBeGreaterThan(MIN_HEALTHY_EDITOR_WIDTH)
})

test('[regress] inEditor -> belowSimulator keeps the editor visible (no root child-count change; must stay healthy)', async () => {
  await clickPreset(mainWindow, 'inEditor')
  await clickPreset(mainWindow, 'belowSimulator')

  const w = await editorWidth(mainWindow)
  expect(w).toBeGreaterThan(MIN_HEALTHY_EDITOR_WIDTH)
})

test('[regress] inEditor <-> rightOfSimulator keeps the editor visible in both directions (neither pins a nested split)', async () => {
  await clickPreset(mainWindow, 'inEditor')
  await clickPreset(mainWindow, 'rightOfSimulator')
  expect(await editorWidth(mainWindow)).toBeGreaterThan(MIN_HEALTHY_EDITOR_WIDTH)

  await clickPreset(mainWindow, 'inEditor')
  expect(await editorWidth(mainWindow)).toBeGreaterThan(MIN_HEALTHY_EDITOR_WIDTH)
})
