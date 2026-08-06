/**
 * Embedded VS Code workbench, project switch: a tab restored from persisted
 * editor state must not strand a "file was not found" placeholder in a project
 * that does not contain that file.
 *
 * Why this can happen at all: the workspace identity is the constant
 * `file:///workspace` (boot.ts builds `workspaceProvider.workspace.folderUri`
 * from `workspace.folderUri`, which every project shares). VS Code derives the
 * WORKSPACE-scope storage database name from that identity
 * (`IndexedDBStorageDatabase.createWorkspaceStorage(workspace.id)`), so ALL
 * projects would read and write ONE `editorpart.state` memento — project A's
 * open tabs restored into project B's workbench, pointing at files B does not
 * have. boot.ts closes that hole by giving the WORKSPACE scope an in-memory
 * storage database, so nothing survives the switch to be restored.
 *
 * The load-bearing detail this spec exists to get right is TIMING. The memento
 * is only written when the storage service flushes, and
 * `BrowserStorageService.BROWSER_DEFAULT_FLUSH_INTERVAL` is 5s
 * (storageService.js:29) — a `RunOnceScheduler` → `runWhenGlobalIdle` →
 * `flush()` → `onWillSaveState` → `EditorPart.saveState()` chain. The
 * WebContentsView is torn down with `webContents.close()` (a true destroy, no
 * shutdown flush), so a switch performed before that 5s window elapses persists
 * NOTHING and the next workbench restores an empty editor part — the bug is
 * invisible and the test passes for the wrong reason. (An earlier version of
 * this spec waited 2s against that 5s interval and passed vacuously.) Step 3
 * therefore sits on the flush window before switching.
 *
 * This spec has been verified to FAIL against a build whose WORKSPACE-scope
 * storage persists: the stale tab comes back and step 5 reports
 * `observed tabs: ["/workspace/pages/storage-test/storage-test.wxml"]`.
 */
import path from 'path'
import { fileURLToPath } from 'url'
import type { ElectronApplication } from '@playwright/test'
import { test, expect } from './fixtures'
import { DEMO_APP_DIR, openProjectInUI, pollUntil } from './helpers'
import { runInWorkbench, attachWorkbenchAndWaitReady } from './workbench-probe'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TABBAR_APP_DIR = path.join(__dirname, 'fixtures', 'tabbar-app')

/** Exists in the demo app only — tabbar-app has no storage-test page. */
const STALE_TAB_PATH = '/workspace/pages/storage-test/storage-test.wxml'

/** Every open editor tab's underlying resource path, across all tab groups. */
const LIST_TAB_PATHS_EXPR = `
  window.__WB_PROBE.vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .map((t) => (t.input && t.input.uri) ? t.input.uri.path : null)
    .filter(Boolean)
`

/** True when a "file was not found" placeholder is on screen. */
const NOT_FOUND_VISIBLE_EXPR = `
  /could not be opened because the file was not found/i.test(document.body.innerText || '')
`

/**
 * How long to sit on the storage flush window before switching projects.
 * 3× BROWSER_DEFAULT_FLUSH_INTERVAL (5s) so a build that persists
 * WORKSPACE-scope state has unambiguously written its memento by then.
 */
const FLUSH_WINDOW_MS = 15_000

/**
 * Read the persisted editor-part state straight out of the workbench's
 * WORKSPACE-scope IndexedDB, the same way VS Code names it:
 * `vscode-web-state-db-<workspace.id>` / object store `ItemTable`, key
 * `memento/workbench.parts.editor` (Memento.COMMON_PREFIX + part id).
 *
 * Returns the raw `editorpart.state` JSON, or `null` when nothing is stored.
 * A substring match on that JSON is deliberate: `FileEditorInput` serializes
 * to a nested JSON *string* (fileEditorHandler.js:27), so a structural walk
 * over the grid would step right past the resources. Enumerating databases
 * instead of recomputing the workspace id keeps this honest — it reports what
 * is actually stored.
 */
const READ_PERSISTED_EDITOR_STATE_EXPR = `
  (async () => {
    const dbs = await indexedDB.databases()
    const names = dbs.map((d) => d.name).filter((n) => n && n.startsWith('vscode-web-state-db-'))
    for (const name of names) {
      const raw = await new Promise((resolve) => {
        const req = indexedDB.open(name)
        req.onerror = () => resolve(null)
        req.onsuccess = () => {
          const db = req.result
          if (!db.objectStoreNames.contains('ItemTable')) { db.close(); resolve(null); return }
          const get = db.transaction('ItemTable', 'readonly')
            .objectStore('ItemTable')
            .get('memento/workbench.parts.editor')
          get.onerror = () => { db.close(); resolve(null) }
          get.onsuccess = () => { db.close(); resolve(get.result ?? null) }
        }
      })
      if (typeof raw !== 'string') continue
      const state = JSON.parse(raw)['editorpart.state']
      if (state) return JSON.stringify(state)
    }
    return null
  })()
`

async function listWorkbenchTabPaths(electronApp: ElectronApplication): Promise<string[]> {
  return runInWorkbench<string[]>(electronApp, LIST_TAB_PATHS_EXPR)
}

test.describe('embedded workbench: project switch discards stale restored tabs', () => {
  test.setTimeout(300_000)

  test('a tab persisted by the previous project must not strand a not-found editor after switching', async ({
    mainWindow,
    electronApp,
  }) => {
    // 1) Open the demo app and bring the embedded workbench up.
    await openProjectInUI(mainWindow, DEMO_APP_DIR, { waitMs: 60_000 })
    const status = await attachWorkbenchAndWaitReady(mainWindow, electronApp)
    expect(status, 'workbench must reach a ready status for the first project').toMatch(
      /workbench-ready|exthost-alive/,
    )

    // 2) Open a file that exists only in the demo app.
    const opened = await runInWorkbench<{ opened: boolean; reason?: string }>(
      electronApp,
      `(async () => {
        const p = window.__WB_PROBE
        try {
          const doc = await p.vscode.workspace.openTextDocument(p.URI.parse('file://${STALE_TAB_PATH}'))
          await p.vscode.window.showTextDocument(doc)
          return { opened: true }
        } catch (e) {
          return { opened: false, reason: String((e && e.message) || e) }
        }
      })()`,
    )
    expect(opened.opened, `the demo-app file must open before switching; got=${JSON.stringify(opened)}`).toBe(true)

    await pollUntil(
      () => listWorkbenchTabPaths(electronApp),
      (paths) => paths.includes(STALE_TAB_PATH),
      20_000,
      500,
    )

    // 3) Sit on the storage flush window so the switch happens in the world
    // where persistence WOULD have landed. A build that persists WORKSPACE
    // state resolves this poll in ~5s (and then reproduces the bug in step 5);
    // the fixed build keeps that scope in memory, so `null` here is the
    // expected outcome and we simply wait the window out. Deliberately not an
    // assertion either way: leftover databases from earlier runs live in the
    // reused per-worker userData dir, so absence is not directly observable.
    const persisted = await pollUntil(
      () => runInWorkbench<string | null>(electronApp, READ_PERSISTED_EDITOR_STATE_EXPR),
      (state) => typeof state === 'string' && state.includes('storage-test'),
      FLUSH_WINDOW_MS,
      1000,
    ).catch(() => null)
    console.info(`[e2e] workspace editor state persisted before switch: ${persisted !== null}`)

    // 4) Switch to a project that does NOT contain that file. This destroys the
    // workbench WebContentsView and boots a fresh one; any persisted editor
    // state would be restored into it, because the workspace identity is the
    // shared constant `file:///workspace`.
    await openProjectInUI(mainWindow, TABBAR_APP_DIR, { waitMs: 60_000 })
    const status2 = await attachWorkbenchAndWaitReady(mainWindow, electronApp)
    expect(status2, 'workbench must reach a ready status after switching projects').toMatch(
      /workbench-ready|exthost-alive/,
    )

    // 5) The restored tab may reappear transiently while the mirror populates,
    // so poll for its absence — only never losing it is a genuine failure.
    const finalPaths = await pollUntil(
      () => listWorkbenchTabPaths(electronApp),
      (paths) => !paths.includes(STALE_TAB_PATH),
      30_000,
      500,
    ).catch(() => listWorkbenchTabPaths(electronApp))
    expect(
      finalPaths,
      `a tab pointing at ${STALE_TAB_PATH} (only present in the previous project) must not survive a switch to tabbar-app; observed tabs: ${JSON.stringify(finalPaths)}`,
    ).not.toContain(STALE_TAB_PATH)

    // 6) The user-visible symptom, independent of how the tab list reads.
    const notFound = await runInWorkbench<boolean>(electronApp, NOT_FOUND_VISIBLE_EXPR)
    expect(notFound, 'no "file was not found" placeholder should be visible after the switch').toBe(false)
  })
})
