import { test, expect } from './fixtures'
import fs from 'node:fs'
import path from 'node:path'
import {
  DEMO_APP_DIR,
  closeProject,
  openProjectInUI,
  waitForEditorReady,
} from './helpers'

/**
 * Verify the WeChat DevTools-style three-region layout:
 *
 *   ┌─ toolbar ──────────────────────────────────────────┐
 *   ├──────────────┬─────────────────────────────────────┤
 *   │  simulator   │  editor (in-renderer Monaco)         │
 *   ├──────────────┴─────────────────────────────────────┤
 *   │ WXML / AppData / Storage / Console tabs            │
 *   └─────────────────────────────────────────────────────┘
 *
 * We don't assert pixel-perfect coordinates (resizable handles + window
 * size depend on the test environment) — instead we verify:
 *
 *   1. All three regions render with non-zero area
 *   2. The simulator and Monaco editor sit in the top half; the
 *      bottom debug panel sits below them
 *   3. react-resizable-panels installed two `[data-panel-resize-handle-id]`
 *      separators (one vertical = top|bottom, one horizontal = sim|editor)
 *   4. The bottom panel exposes the four expected debug tabs
 *
 * A screenshot is captured to test-results/wechat-layout.png for visual
 * inspection.
 */
test('WeChat-style three-region layout: simulator | editor / bottom tabs', async ({ mainWindow }) => {
  await openProjectInUI(mainWindow, DEMO_APP_DIR)
  await waitForEditorReady(mainWindow)

  // 1. All three region rects exist with non-zero area.
  const rects = await mainWindow.evaluate(() => {
    const sim = document.querySelector('iframe, webview') as HTMLElement | null
    const editor = document.querySelector('[data-area="editor"]') as HTMLElement | null
    const bottomTabs = document.querySelector('[data-bottom-debug-tabs]') as HTMLElement | null
    const grab = (el: HTMLElement | null) => {
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: r.left, y: r.top, w: r.width, h: r.height }
    }
    return {
      sim: grab(sim),
      editor: grab(editor),
      bottomTabs: grab(bottomTabs),
      winH: window.innerHeight,
    }
  })

  expect(rects.sim, 'simulator <webview> placeholder').not.toBeNull()
  expect(rects.editor, 'editor placeholder div').not.toBeNull()
  expect(rects.bottomTabs, 'bottom debug tab bar').not.toBeNull()
  expect(rects.editor!.w).toBeGreaterThan(50)
  expect(rects.editor!.h).toBeGreaterThan(50)
  expect(rects.sim!.w).toBeGreaterThan(50)

  // 2. Bottom tab bar sits BELOW the editor placeholder (which fills its
  //    panel exactly — the simulator's inner <webview> can render taller
  //    than its panel because the phone chrome scrolls inside an
  //    `overflow:auto` parent, so we anchor off the editor placeholder
  //    instead). 4px slack for the resize separator + sub-pixel rounding.
  expect(rects.bottomTabs!.y).toBeGreaterThanOrEqual(rects.editor!.y + rects.editor!.h - 4)

  // 3. Two resize handles installed by react-resizable-panels.
  //    The library renders them as <Separator> with role="separator" and
  //    `data-resize-handle-active` toggling on drag; they also carry a
  //    `data-orientation` attribute we can inspect.
  const handles = await mainWindow.$$eval('[role="separator"]', (els) =>
    els.map((el) => ({
      orientation: el.getAttribute('data-orientation'),
      ariaOrientation: el.getAttribute('aria-orientation'),
    })),
  )
  // We expect at least the two we created (vertical = top|bottom split;
  // horizontal = sim|editor split). Other separators (e.g. inside the
  // simulator chrome) may exist, so we filter to ones from our groups.
  const hasVertical = handles.some(
    (h) => h.orientation === 'vertical' || h.ariaOrientation === 'vertical',
  )
  const hasHorizontal = handles.some(
    (h) => h.orientation === 'horizontal' || h.ariaOrientation === 'horizontal',
  )
  expect(hasVertical, `resize handles seen: ${JSON.stringify(handles)}`).toBe(true)
  expect(hasHorizontal, `resize handles seen: ${JSON.stringify(handles)}`).toBe(true)

  // 4. Four expected tabs in the bottom panel.
  const tabIds = await mainWindow.$$eval(
    '[data-bottom-debug-tabs] [data-tab-id]',
    (els) => els.map((el) => el.getAttribute('data-tab-id')),
  )
  expect(tabIds).toEqual(['wxml', 'appdata', 'storage', 'simulator'])

  // 5. Screenshot for visual verification.
  const outDir = 'test-results'
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
  await mainWindow.screenshot({ path: path.join(outDir, 'wechat-layout.png') })
})

/**
 * Cold-start regression: opening a project must auto-open a sensible entry
 * file *with content* — no manual file-tree click required.
 *
 * Before the readFile retry, the main process's active project could be
 * briefly unregistered (`ENOACTIVE`) — or the Monaco instance not yet
 * mounted — when the auto-open fired, leaving the editor blank until the
 * user clicked a file. We assert the editor renders real text shortly
 * after the project opens.
 */
test('cold start auto-opens the entry file with content (no manual click)', async ({ mainWindow }) => {
  await openProjectInUI(mainWindow, DEMO_APP_DIR)
  await waitForEditorReady(mainWindow)

  // Monaco virtualises lines into `.view-lines`; once a model is attached
  // and laid out, the auto-opened entry file's text appears there. Poll
  // until non-empty (the whole point: it must fill itself in).
  await mainWindow.waitForFunction(
    () => {
      const lines = document.querySelector('[data-area="editor"] .view-lines')
      return !!lines && (lines.textContent ?? '').trim().length > 0
    },
    undefined,
    { timeout: 25000 },
  )

  const editorText = await mainWindow.evaluate(() => {
    const lines = document.querySelector('[data-area="editor"] .view-lines')
    return (lines?.textContent ?? '').trim()
  })

  expect(editorText.length, 'auto-opened editor should not be blank').toBeGreaterThan(0)
  // The demo app's preferred entry is `app.json`, whose first key is `pages`.
  expect(editorText).toContain('pages')
})

test.afterEach(async ({ mainWindow }) => {
  await closeProject(mainWindow)
})
