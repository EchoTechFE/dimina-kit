/**
 * Editor save → dmcc rebuild → simulator hot reload.
 *
 * Regression spec for "保存后模拟器不刷新": a later refactor (a85fb6dc) deleted
 * the `<webview>`-era `hotReload → reload()` wiring without adding a
 * native-host equivalent. The whole upstream chain still works — the Monaco
 * write path lands on disk, chokidar fires, dmcc recompiles in ~1-2s and the
 * toolbar flips to "编译完成，已热更新" — but the renderer drops the
 * `hotReload` flag, the attach effect's deps don't change, and the DeviceShell
 * is never respawned. The page keeps showing stale content forever.
 *
 * This spec asserts the END-TO-END user contract: after a save, the NEW
 * content must appear in the simulator DOM within a bounded window. It is
 * expected to FAIL (on the "DOM shows the marker" assertions) until the
 * renderer hotReloadToken → re-attach fix lands.
 *
 * DOM probing: screenshots can't capture nested webview content, so we read
 * `document.body.innerText` of every render-host page guest
 * (`pageFrame.html`) directly in the main process — same probe the
 * .repro/editor-refresh-spike investigation validated.
 *
 * File hygiene: demo-app sources are mutated; both tests restore the original
 * bytes in `finally` and then wait out one rebuild cycle so a failure here
 * can never bleed a half-built output into later specs (the lesson from
 * relaunch-resilience.spec.ts).
 */
import fs from 'fs'
import path from 'path'
import { test, expect } from './fixtures'
import {
  DEMO_APP_DIR,
  openProjectInUI,
  closeProject,
  pollUntil,
  ipcInvoke,
} from './helpers'
import { ProjectFsChannel } from '../src/shared/ipc-channels'

// ── Probes ───────────────────────────────────────────────────────────────

/**
 * Concatenated visible text of every render-host page guest. Returns '' when
 * no guest is ready yet (callers poll).
 */
async function readRenderText(
  electronApp: import('@playwright/test').ElectronApplication,
): Promise<string> {
  try {
    return await electronApp.evaluate(async ({ webContents }) => {
      const frames = webContents
        .getAllWebContents()
        .filter((wc) => !wc.isDestroyed() && wc.getURL().includes('pageFrame.html'))
      const texts: string[] = []
      for (const f of frames) {
        try {
          texts.push((await f.executeJavaScript('document.body.innerText')) as string)
        } catch {
          // guest navigating / not ready — skip
        }
      }
      return texts.join('\n---FRAME---\n')
    })
  } catch {
    return ''
  }
}

/** Wait until the simulator's rendered text satisfies `predicate`. */
async function waitForRenderText(
  electronApp: import('@playwright/test').ElectronApplication,
  predicate: (text: string) => boolean,
  timeout: number,
): Promise<string> {
  return pollUntil(() => readRenderText(electronApp), predicate, timeout, 1000)
}

/**
 * Save a project file through the SAME path the Monaco editor uses
 * (`MonacoEditor.tsx` flushPendingSave → `project:fs:writeFile` IPC), so the
 * spec exercises the real user flow, not a filesystem shortcut.
 */
async function saveViaMonacoPath(
  mainWindow: import('@playwright/test').Page,
  absPath: string,
  content: string,
): Promise<void> {
  await ipcInvoke(mainWindow, ProjectFsChannel.WriteFile, absPath, content)
}

/**
 * Post-test settle: restore already happened (caller's finally); wait for the
 * restore-triggered rebuild to finish so the next spec opens against a clean,
 * fully-compiled output. Best-effort — never throws.
 */
async function settleAfterRestore(
  mainWindow: import('@playwright/test').Page,
): Promise<void> {
  // The restore write itself triggers one watcher rebuild (~1-2s compile).
  // Wait for that rebuild to actually start (toolbar leaves the settled "完成"
  // state into "编译中…/刷新中…"), bounded so a no-op restore doesn't stall,
  // then wait for it to settle back to "…完成". This replaces a blind 8s sleep
  // with condition-based waits — the common case finishes in ~2-3s.
  const compileStatus = () =>
    mainWindow.evaluate(() => {
      const els = document.querySelectorAll('[class*="truncate"]')
      for (const el of els) {
        const t = el.textContent || ''
        if (t.includes('完成')) return 'done'
        if (t.includes('编译') || t.includes('刷新') || t.includes('...') || t.includes('…')) return 'building'
      }
      return 'unknown'
    })
  // Observe the rebuild kick off (toolbar flips to "编译中…"), bounded — a
  // restore that produces identical output may never flip.
  const sawBuilding = await pollUntil(compileStatus, (s) => s === 'building', 4000, 200)
    .then((s) => s === 'building')
    .catch(() => false)
  // Only wait for the settle if a rebuild actually started; otherwise a stale
  // pre-restore "完成" would let us return before the rebuild even runs.
  if (sawBuilding) {
    await pollUntil(compileStatus, (s) => s === 'done', 10000, 300).catch(() => {})
  }
}

// How long the simulator gets to show fresh content after a save. The spike
// measured rebuild completion (status flip + output mtime) within ~1-2s, so
// 20s is rebuild + respawn + first paint with a wide margin — a miss at 20s
// means "no reload wiring", not "slow machine".
const HOT_RELOAD_WINDOW_MS = 20_000

// ── Tests ────────────────────────────────────────────────────────────────

test.describe('Editor hot reload (save → rebuild → simulator refresh)', () => {
  test.setTimeout(150_000)

  test.beforeEach(async ({ mainWindow, electronApp }) => {
    await openProjectInUI(mainWindow, DEMO_APP_DIR, { waitMs: 30000 })
    // Baseline: the home page must actually be rendering before we mutate
    // sources — otherwise a missing marker would just mean "never rendered".
    const baseline = await waitForRenderText(
      electronApp,
      (t) => t.includes('DevTools 功能测试'),
      40000,
    )
    expect(baseline, 'home page must render its baseline text before the test mutates sources').toContain(
      'DevTools 功能测试',
    )
  })

  test.afterEach(async ({ mainWindow }) => {
    await closeProject(mainWindow)
  })

  test('saving index.wxml via the Monaco write path refreshes the simulator with the new text', async ({
    mainWindow,
    electronApp,
  }) => {
    const wxmlPath = path.join(DEMO_APP_DIR, 'pages', 'index', 'index.wxml')
    const original = fs.readFileSync(wxmlPath, 'utf8')
    const marker = `E2E_HOT_WXML_${Date.now()}`

    try {
      const mutated = original.replace('DevTools 功能测试', `DevTools 功能测试 ${marker}`)
      expect(mutated, 'marker substitution target must exist in index.wxml').not.toBe(original)

      await saveViaMonacoPath(mainWindow, wxmlPath, mutated)
      // Sanity: the Monaco write path actually landed on disk (this part has
      // always worked — the regression is strictly downstream).
      expect(fs.readFileSync(wxmlPath, 'utf8')).toContain(marker)

      // THE regression assertion: the watcher rebuild completes in ~1-2s and
      // must be followed by a simulator refresh that shows the new text.
      const text = await waitForRenderText(
        electronApp,
        (t) => t.includes(marker),
        HOT_RELOAD_WINDOW_MS,
      )
      expect(
        text,
        `simulator DOM must show the saved wxml text within ${HOT_RELOAD_WINDOW_MS / 1000}s of a Monaco save (hotReload → DeviceShell respawn)`,
      ).toContain(marker)
    } finally {
      fs.writeFileSync(wxmlPath, original, 'utf8')
      await settleAfterRestore(mainWindow)
    }
  })

  test('saving index.js data via the Monaco write path refreshes the simulator with the new data', async ({
    mainWindow,
    electronApp,
  }) => {
    const jsPath = path.join(DEMO_APP_DIR, 'pages', 'index', 'index.js')
    const original = fs.readFileSync(jsPath, 'utf8')
    const marker = `E2E_HOT_JS_${Date.now()}`

    try {
      // Rename a menu-item title in `data` — it renders on the home page via
      // `{{item.title}}`, so the marker is plain visible text after reload.
      const mutated = original.replace("'Storage 存储测试'", `'Storage ${marker}'`)
      expect(mutated, 'marker substitution target must exist in index.js').not.toBe(original)

      await saveViaMonacoPath(mainWindow, jsPath, mutated)
      expect(fs.readFileSync(jsPath, 'utf8')).toContain(marker)

      const text = await waitForRenderText(
        electronApp,
        (t) => t.includes(marker),
        HOT_RELOAD_WINDOW_MS,
      )
      expect(
        text,
        `simulator DOM must show the saved js data within ${HOT_RELOAD_WINDOW_MS / 1000}s of a Monaco save (hotReload → DeviceShell respawn)`,
      ).toContain(marker)
    } finally {
      fs.writeFileSync(jsPath, original, 'utf8')
      await settleAfterRestore(mainWindow)
    }
  })
})
