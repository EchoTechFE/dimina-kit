/**
 * REAL HTML5 drag-to-REORDER of a debug tab within its own tab strip.
 *
 * The five debug panels (wxml/appdata/storage/console/compile) are registered
 * `dropPolicy:'reorder-only'`: a drag may ONLY reorder them within their own tab
 * group, never tear them into another region. Reordering is committed when a tab
 * is dropped onto the TAB STRIP (which would otherwise resolve to the group's
 * `top` edge zone and no-op) — `handleTabStripDrop` derives the pointer-x
 * insertion index via `computeReorderIndex` and commits a within-group move.
 *
 * jsdom can't exercise this (getBoundingClientRect is 0), so this drives the
 * real gesture in a real Electron renderer with real geometry — synthesizing the
 * exact `dragstart → dragover → drop → dragend` sequence with ONE shared
 * DataTransfer, exactly as `dock-real-drag.spec.ts` does for split/join.
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
    'dock-tab-reorder',
  )
  electronApp = await _electron.launch({
    args: [appPath, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, NODE_ENV: 'test' },
  })
  mainWindow = await electronApp.firstWindow()
  await mainWindow.waitForLoadState('domcontentloaded')
  await installConsoleCollector(electronApp)
  await electronApp.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) { win.setPosition(-2000, -2000); win.blur() }
  })
  await openProjectInUI(mainWindow, DEMO_APP_DIR)
  await mainWindow.waitForSelector('[data-deck-tab="storage"]', { timeout: 15000 })
})

test.afterAll(async () => {
  try { await closeProject(mainWindow) } catch { /* best effort */ }
  await electronApp.close()
})

/** The ordered panel ids of the tab group that currently owns `panelId`. */
async function tabOrderOfGroupOwning(page: PwPage, panelId: string): Promise<string[]> {
  return page.evaluate((pid) => {
    const tab = document.querySelector(`[data-deck-tab="${pid}"]`)
    const group = tab?.closest('[data-deck-group]')
    if (!group) return []
    return Array.from(group.querySelectorAll('[data-deck-tab]')).map(
      (t) => t.getAttribute('data-deck-tab') ?? '',
    )
  }, panelId)
}

/**
 * Drag `draggedPanelId` and drop it onto `targetPanelId`'s TAB at normalized
 * x-fraction `fx` of that tab (fx<0.5 → insert before the target, fx>0.5 →
 * after). Drops on the tab (which bubbles to the tab strip), exercising the real
 * reorder path. Returns any thrown error for a "no uncaught error" assertion.
 */
async function realReorderTab(
  page: PwPage,
  draggedPanelId: string,
  targetPanelId: string,
  fx: number,
): Promise<{ ok: boolean; error: string | null }> {
  return page.evaluate(
    async ({ draggedPanelId, targetPanelId, fx }) => {
      try {
        const tab = document.querySelector(`[data-deck-tab="${draggedPanelId}"]`) as HTMLElement | null
        const targetTab = document.querySelector(`[data-deck-tab="${targetPanelId}"]`) as HTMLElement | null
        if (!tab) return { ok: false, error: `no source tab ${draggedPanelId}` }
        if (!targetTab) return { ok: false, error: `no target tab ${targetPanelId}` }

        const tRect = targetTab.getBoundingClientRect()
        const clientX = tRect.left + tRect.width * fx
        const clientY = tRect.top + tRect.height / 2

        const dt = new DataTransfer()
        const fire = (el: Element, type: string, x: number, y: number): void => {
          const ev = new DragEvent(type, {
            bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y,
          })
          Object.defineProperty(ev, 'dataTransfer', { value: dt, configurable: true })
          el.dispatchEvent(ev)
        }
        const flush = (): Promise<void> =>
          new Promise((resolve) => requestAnimationFrame(() => resolve()))

        const sRect = tab.getBoundingClientRect()
        fire(tab, 'dragstart', sRect.left + sRect.width / 2, sRect.top + sRect.height / 2)
        fire(targetTab, 'dragenter', clientX, clientY)
        fire(targetTab, 'dragover', clientX, clientY)
        await flush()
        fire(targetTab, 'drop', clientX, clientY)
        fire(tab, 'dragend', clientX, clientY)
        await flush()
        return { ok: true, error: null }
      } catch (e) {
        return { ok: false, error: String((e as Error)?.stack ?? e) }
      }
    },
    { draggedPanelId, targetPanelId, fx },
  )
}

test('debug tab reorders within its own strip on a drag-drop (real gesture)', async () => {
  // Order-INDEPENDENT: the e2e userDataDir persists the dock tree across runs, so
  // we don't assume the pristine default order — we capture whatever it is now.
  const before = await tabOrderOfGroupOwning(mainWindow, 'storage')
  // The five debug panels are co-located in one group.
  expect([...before].sort()).toEqual(['appdata', 'compile', 'console', 'storage', 'wxml'])

  // Drag the CURRENT first tab and drop it onto the RIGHT half of the CURRENT
  // last tab → it should move to the END of the strip.
  const first = before[0]
  const last = before[before.length - 1]
  const res = await realReorderTab(mainWindow, first, last, 0.9)
  expect(res.error, 'reorder gesture threw').toBeNull()
  expect(res.ok).toBe(true)

  const after = await tabOrderOfGroupOwning(mainWindow, 'storage')
  // Same five panels, still ONE group, but the dragged tab moved to the end.
  expect([...after].sort()).toEqual([...before].sort())
  expect(after).toEqual([...before.slice(1), first])
  expect(after).not.toEqual(before)
})

test('a debug tab cannot be torn OUT of its group into another region', async () => {
  // Reorder-only: dropping a debug tab onto the EDITOR region (its body center)
  // must be a no-op — the panel stays in the debug group; the editor group is
  // not joined/split. (Drives the GOAL-B "never leave the group" guard with real
  // geometry, complementing the jsdom seam tests.)
  const groupsBefore = await mainWindow.evaluate(() =>
    Array.from(document.querySelectorAll('[data-deck-group]')).map((g) => ({
      id: g.getAttribute('data-deck-group'),
      // Include non-tab panels (hideTab: simulator/editor) via their body/native slot.
      panels: Array.from(
        g.querySelectorAll('[data-deck-tab], [data-deck-panel-body], [data-deck-native-slot]'),
      ).map(
        (t) =>
          t.getAttribute('data-deck-tab') ??
          t.getAttribute('data-deck-panel-body') ??
          t.getAttribute('data-deck-native-slot'),
      ),
    })),
  )

  // Drop 'storage' onto the center of the editor group's body.
  await mainWindow.evaluate(async () => {
    const tab = document.querySelector('[data-deck-tab="storage"]') as HTMLElement
    // editor has no tab (hideTab) — locate its group via the panel body.
    const editorBody = document.querySelector('[data-deck-panel-body="editor"]') as HTMLElement
    const group = editorBody.closest('[data-deck-group]') as HTMLElement
    const r = group.getBoundingClientRect()
    const x = r.left + r.width * 0.5
    const y = r.top + r.height * 0.5
    const dt = new DataTransfer()
    const fire = (el: Element, type: string, cx: number, cy: number) => {
      const ev = new DragEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: cx, clientY: cy })
      Object.defineProperty(ev, 'dataTransfer', { value: dt, configurable: true })
      el.dispatchEvent(ev)
    }
    const flush = () => new Promise<void>((res) => requestAnimationFrame(() => res()))
    const sr = tab.getBoundingClientRect()
    fire(tab, 'dragstart', sr.left + sr.width / 2, sr.top + sr.height / 2)
    fire(group, 'dragenter', x, y)
    fire(group, 'dragover', x, y)
    await flush()
    fire(group, 'drop', x, y)
    fire(tab, 'dragend', x, y)
    await flush()
  })

  const groupsAfter = await mainWindow.evaluate(() =>
    Array.from(document.querySelectorAll('[data-deck-group]')).map((g) => ({
      id: g.getAttribute('data-deck-group'),
      // Include non-tab panels (hideTab: simulator/editor) via their body/native slot.
      panels: Array.from(
        g.querySelectorAll('[data-deck-tab], [data-deck-panel-body], [data-deck-native-slot]'),
      ).map(
        (t) =>
          t.getAttribute('data-deck-tab') ??
          t.getAttribute('data-deck-panel-body') ??
          t.getAttribute('data-deck-native-slot'),
      ),
    })),
  )
  // 'storage' is still wherever it was — never joined the editor group.
  const storageGroupBefore = groupsBefore.find((g) => g.panels.includes('storage'))!.id
  const storageGroupAfter = groupsAfter.find((g) => g.panels.includes('storage'))!.id
  expect(storageGroupAfter).toBe(storageGroupBefore)
  const editorGroupAfter = groupsAfter.find((g) => g.panels.includes('editor'))!
  expect(editorGroupAfter.panels).not.toContain('storage')

  // No genuine renderer errors from the reorder gestures (filter pre-existing
  // DevTools/network noise, mirroring dock-real-drag.spec.ts). The editor body
  // is now a live dock body whose anchor lazily attaches the embedded A2
  // workbench WebContentsView; that third-party VS Code bundle emits its own
  // startup warnings/errors (extension-host sandbox notes, settings-schema and
  // workspace-mirror chatter) which are unrelated to the drag gesture — filter
  // them by their workbench origin/source markers.
  const errors = await readConsoleErrors(electronApp)
  const relevant = errors.filter((e) => {
    if (/favicon|DevTools|Autofill|net::ERR|Failed to load resource/i.test(e.message)) return false
    // A2 workbench WCV noise (served from a 127.0.0.1 COI origin; bundles named
    // localExtensionHost / webWorkerExtensionHost / the workbench index chunk).
    if (/ExtensionHost|a2-spike|local-network-access|allow-scripts and allow-same-origin/i.test(
      `${e.message} ${e.source} ${e.url}`,
    )) return false
    if (/json\.schemas is not a registered configuration|Unable to resolve nonexistent file '\/workspace'/i.test(e.message)) return false
    return true
  })
  expect(relevant, `unexpected renderer errors: ${JSON.stringify(relevant)}`).toEqual([])
})

test('simulator + editor render NO tab (hideTab), but their panels still exist', async () => {
  // The two structural panels draw their own chrome — no engine tab header.
  expect(await mainWindow.locator('[data-deck-tab="simulator"]').count()).toBe(0)
  expect(await mainWindow.locator('[data-deck-tab="editor"]').count()).toBe(0)
  // …yet their bodies are still mounted (the panels render, just tabless).
  expect(await mainWindow.locator('[data-deck-panel-body="editor"]').count()).toBeGreaterThan(0)
  // debug tabs still have their headers.
  expect(await mainWindow.locator('[data-deck-tab="storage"]').count()).toBe(1)
})

test('the active debug panel body fills its full height (no dead space below)', async () => {
  // Activate a DOM debug tab so its body is the visible one, then verify the
  // panel content stretches to the body height (the #51 flex-fill regression).
  await mainWindow.click('[data-deck-tab="storage"]')
  await mainWindow.waitForTimeout(200)
  const fit = await mainWindow.evaluate(() => {
    const body = document.querySelector('[data-deck-panel-body="storage"]') as HTMLElement | null
    if (!body) return null
    const child = body.firstElementChild as HTMLElement | null
    if (!child) return null
    const b = body.getBoundingClientRect()
    const c = child.getBoundingClientRect()
    return { bodyH: Math.round(b.height), childH: Math.round(c.height), display: getComputedStyle(body).display }
  })
  expect(fit, 'storage body + content must exist').not.toBeNull()
  expect(fit!.bodyH, 'the panel body must have real height').toBeGreaterThan(100)
  // The content root fills the body (within a couple px), not collapsed to content height.
  expect(
    fit!.childH,
    `panel content (${fit!.childH}px) must fill its body (${fit!.bodyH}px), display=${fit!.display}`,
  ).toBeGreaterThanOrEqual(fit!.bodyH - 4)
})
