/**
 * REAL-ELECTRON proof of the two dock behaviors jsdom/vitest CANNOT verify:
 *
 *  A3 (DOM-panel keepalive — state survives a tab switch): a kept-alive debug
 *      panel body is NOT remounted when you switch away and back; its React
 *      subtree (and any local UI state — scroll position, an imperatively
 *      stamped DOM node) PERSISTS. jsdom proves the *callback* is re-invoked
 *      with a flipped `active` flag, but only a real renderer with real layout
 *      can prove the live DOM element survived (identity) and that a scrollable
 *      body kept its scrollTop across A→B→A.
 *
 *  B1 (simulator native WCV collapses when hidden): the simulator is a
 *      structural DOM panel that owns its own region (`hideTab:true`), so it has
 *      no sibling tab to deactivate it — the real collapse trigger is the
 *      toolbar "隐藏模拟器" toggle. Hiding it `closePanelForUser`s the panel; the
 *      unmounting `SimulatorPanel` publishes `{ visible:false }` → COLLAPSED 0×0
 *      bounds, DETACHING the WebContentsView from the contentView tree while
 *      keeping the WebContents alive. jsdom has no WCV and no real layout, so
 *      only real Electron can prove the native bounds collapse to 0×0 when the
 *      panel is hidden and restore when it is shown again.
 *
 * The native-bounds probe mirrors `dock-real-drag.spec.ts`'s `simulatorBounds`
 * (walks each window's contentView subtree for the view whose webContents is
 * the simulator and reads its live `getBounds()`).
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
    'dock-keepalive-and-collapse',
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
 * Native simulator WCV state, as observed from main:
 *  - `alive`: a WebContents loading `simulator.html` still EXISTS (the WCV's
 *    web contents is never destroyed on deactivation — only detached).
 *  - `bounds`: the live `getBounds()` of the simulator view IFF it is currently
 *    attached to a window's contentView subtree; `null` when the view is
 *    DETACHED from the tree (the collapse path `removeChildView`-es it).
 *
 * This mirrors `dock-real-drag.spec.ts`'s `simulatorBounds` tree walk, but
 * additionally reports `alive` so the collapse can be distinguished from a
 * destroy: B1 collapse = `alive && bounds === null` (detached-but-kept-alive),
 * exactly as `view-manager.ts setNativeSimulatorViewBounds` implements a
 * zero-area rect.
 */
async function simulatorView(
  app: ElectronApplication,
): Promise<{ alive: boolean; bounds: { x: number; y: number; w: number; h: number } | null }> {
  return app.evaluate(({ webContents, BrowserWindow }) => {
    const wcs = webContents.getAllWebContents()
    const sim = wcs.find((wc) => {
      try { return wc.getURL().includes('simulator.html') } catch { return false }
    })
    if (!sim) return { alive: false, bounds: null }
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
          return { alive: true, bounds: { x: b.x, y: b.y, w: b.width, h: b.height } }
        }
        for (const c of (v?.children ?? [])) stack.push(c)
      }
    }
    // The simulator WebContents is alive but its view is not in any contentView
    // tree → DETACHED (collapsed).
    return { alive: true, bounds: null }
  })
}

/** Activate a dock tab by id and wait until it is the active body. */
async function activateTab(page: PwPage, panelId: string): Promise<void> {
  await page.locator(`[data-deck-tab="${panelId}"]`).first().click()
  // The active body is the one NOT display:none.
  await page.waitForFunction(
    (id) => {
      const body = document.querySelector(`[data-deck-panel-body="${id}"]`) as HTMLElement | null
      if (!body) return false
      return getComputedStyle(body).display !== 'none'
    },
    panelId,
    { timeout: 8000 },
  )
}

// ─────────────────────────── A3: keepalive ───────────────────────────

test('A3: a kept-alive debug body is NOT remounted across a tab switch (DOM identity + scroll survive)', async () => {
  // Activate WXML, then stamp the live body: (1) a unique marker attribute on a
  // DEEP React-rendered child (NOT the keyed wrapper) — a true remount would
  // build a brand-new element and lose the imperatively-set attribute; (2) a
  // scrollTop on the first scrollable descendant. Both must survive A→B→A iff
  // the body was kept alive (display:none) rather than unmounted.
  await activateTab(mainWindow, 'wxml')

  const stamp = `keepalive-${Date.now()}`
  const stamped = await mainWindow.evaluate((mark) => {
    const body = document.querySelector('[data-deck-panel-body="wxml"]') as HTMLElement | null
    if (!body) return { ok: false, reason: 'no wxml body' }

    // A deep child that React owns: pick the deepest element node so that a
    // remount would necessarily replace it. Fall back to the body's first
    // element child. We stamp via a data-* attribute set IMPERATIVELY (outside
    // React) — React re-renders patch attributes it manages, but never re-adds
    // a foreign attribute we set, and a true unmount/remount discards the node
    // entirely, taking the attribute with it.
    const all = body.querySelectorAll('*')
    const target = (all[all.length - 1] as HTMLElement) ?? (body.firstElementChild as HTMLElement) ?? body
    target.setAttribute('data-e2e-keepalive-mark', mark)

    // Find a scrollable descendant (overflow auto/scroll with content taller
    // than its box) and scroll it. If none exists we still have the identity
    // probe; record whether scroll was exercised.
    let scrolledEl: HTMLElement | null = null
    const candidates = [body, ...Array.from(body.querySelectorAll('*'))] as HTMLElement[]
    for (const el of candidates) {
      if (el.scrollHeight > el.clientHeight + 4) {
        el.scrollTop = Math.min(40, el.scrollHeight - el.clientHeight)
        if (el.scrollTop > 0) { scrolledEl = el; break }
      }
    }
    if (scrolledEl) scrolledEl.setAttribute('data-e2e-scroll-probe', mark)

    return {
      ok: true,
      markedTag: target.tagName,
      scrolledTop: scrolledEl ? scrolledEl.scrollTop : null,
    }
  }, stamp)
  expect(stamped.ok, `wxml body must be present to stamp: ${JSON.stringify(stamped)}`).toBe(true)

  // Switch AWAY to storage, then assert wxml stayed MOUNTED but hidden (the
  // keepalive contract: inactive body is display:none, NOT removed).
  await activateTab(mainWindow, 'storage')
  const wxmlHiddenButMounted = await mainWindow.evaluate(() => {
    const body = document.querySelector('[data-deck-panel-body="wxml"]') as HTMLElement | null
    if (!body) return { mounted: false, display: null as string | null }
    return { mounted: true, display: getComputedStyle(body).display }
  })
  expect(wxmlHiddenButMounted.mounted, 'inactive wxml body must remain MOUNTED (keepalive)').toBe(true)
  expect(wxmlHiddenButMounted.display, 'inactive wxml body must be display:none').toBe('none')

  // Switch BACK to wxml and assert the stamped element + scroll survived — i.e.
  // the body was the SAME instance, never remounted.
  await activateTab(mainWindow, 'wxml')
  const survived = await mainWindow.evaluate((mark) => {
    const body = document.querySelector('[data-deck-panel-body="wxml"]') as HTMLElement | null
    if (!body) return { ok: false, markFound: false, scrollTop: null as number | null, hadScrollProbe: false }
    const marked = body.querySelector(`[data-e2e-keepalive-mark="${mark}"]`)
    const scrollProbe = body.querySelector(`[data-e2e-scroll-probe="${mark}"]`) as HTMLElement | null
    return {
      ok: true,
      markFound: marked !== null,
      hadScrollProbe: scrollProbe !== null,
      scrollTop: scrollProbe ? scrollProbe.scrollTop : null,
    }
  }, stamp)

  expect(survived.ok, 'wxml body must be present after switching back').toBe(true)
  // The decisive non-remount assertion: the imperatively-stamped element is
  // still in the DOM. A remount would have discarded it.
  expect(
    survived.markFound,
    'the stamped element must SURVIVE the tab switch (proves the body was NOT remounted)',
  ).toBe(true)
  // If a scrollable region existed, its scrollTop must have persisted too.
  if (survived.hadScrollProbe) {
    expect(
      survived.scrollTop,
      'scroll position must persist across the tab switch (kept-alive body)',
    ).toBeGreaterThan(0)
  }
})

// ─────────────────────── B1: simulator WCV collapse ───────────────────────

test('B1: the simulator native WCV collapses (detaches, kept alive) when the simulator panel is hidden, and restores when shown', async () => {
  // simulator is a STRUCTURAL panel (`hideTab:true`, alone in its region) — there
  // is no sibling tab to deactivate it. The real UI trigger for collapse is the
  // toolbar "隐藏模拟器" toggle: it `closePanelForUser`s the simulator → the
  // `SimulatorPanel` unmounts → its view-anchor publishes `{ visible:false }` →
  // main maps the zero-area rect to COLLAPSE, `removeChildView`-ing the WCV from
  // the contentView tree (detach) while keeping its WebContents alive. So the
  // collapse is observed as `alive && bounds === null`.
  const toggle = mainWindow.locator('[data-testid="layout-toolbar-toggle-simulator"]')

  // Baseline: the simulator WCV is attached with live, non-zero bounds.
  await mainWindow.waitForTimeout(500)
  const active = await simulatorView(electronApp)
  expect(active.alive, 'simulator WebContents must be alive while shown').toBe(true)
  expect(active.bounds, 'shown simulator WCV must be ATTACHED with live bounds').not.toBeNull()
  expect(
    active.bounds!.w * active.bounds!.h,
    `shown simulator WCV must have NON-ZERO area (got ${JSON.stringify(active.bounds)})`,
  ).toBeGreaterThan(0)

  // Hide the simulator via the real toolbar toggle → detach-but-keep-alive.
  await toggle.click()
  await mainWindow.waitForTimeout(800)

  const collapsed = await simulatorView(electronApp)
  expect(
    collapsed.alive,
    'the simulator WebContents must stay ALIVE when hidden (detach, not destroy)',
  ).toBe(true)
  expect(
    collapsed.bounds,
    'the hidden simulator WCV must COLLAPSE — detached from the contentView tree (no live bounds)',
  ).toBeNull()

  // Show the simulator again → the slot re-mounts → the anchor re-publishes a
  // non-zero rect → main re-attaches the WCV and restores its bounds.
  await toggle.click()
  await mainWindow.waitForTimeout(800)

  const restored = await simulatorView(electronApp)
  expect(restored.alive, 'simulator WebContents must still be alive after being shown again').toBe(true)
  expect(restored.bounds, 'reshown simulator WCV must be RE-ATTACHED with live bounds').not.toBeNull()
  expect(
    restored.bounds!.w * restored.bounds!.h,
    `reshown simulator WCV must RESTORE to non-zero area (got ${JSON.stringify(restored.bounds)})`,
  ).toBeGreaterThan(0)
})
