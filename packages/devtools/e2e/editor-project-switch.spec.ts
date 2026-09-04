/**
 * Embedded VS Code workbench, project switch: a tab persisted by one project
 * must not be restored into the next one, stranding a "file was not found"
 * placeholder for a file that project does not contain.
 *
 * Why this can happen at all: every project is mirrored at the constant
 * `file:///workspace` root, and VS Code names the WORKSPACE-scope storage
 * database after the workspace identity
 * (`IndexedDBStorageDatabase.createWorkspaceStorage(workspace.id)`), which it
 * derives by hashing the folder URI unless it is handed one. One constant URI
 * ⇒ ALL projects read and write ONE `editorpart.state` memento — project A's
 * open tabs restored into project B's workbench, pointing at files B does not
 * have. The fix names the workspace after the miniapp instead: the devtools
 * host appends `index.html?workspaceId=<appId key>` to the workbench URL and
 * boot.ts passes it through as the explicit workspace id, so every project gets
 * its own bucket.
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
 * Both halves are asserted, because isolation and amnesia look identical from
 * the tab list: the outgoing project's editor state really is written (step 3)
 * and is STILL on disk after the switch (step 6), yet is not restored into the
 * incoming project (step 5). Isolation comes from the two projects having
 * different workspace ids (step 4), not from throwing state away.
 *
 * This spec has been verified to FAIL against a build whose workspace identity
 * is the shared folder-URI hash: the stale tab comes back and step 5 reports
 * `observed tabs: ["/workspace/pages/storage-test/storage-test.wxml"]`.
 */
import path from 'path'
import { fileURLToPath } from 'url'
import type { ElectronApplication } from '@playwright/test'
import { test, expect } from './fixtures'
import { DEMO_APP_DIR, openProjectInUI, closeProject, pollUntil } from './helpers'
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
 * VS Code's own view of this window's workspace identity — the value it names
 * the WORKSPACE-scope storage database after
 * (`vscode-web-state-db-<workspace.id>`). Read from the live workspace service
 * rather than from whatever the host passed in, so the assertion is about the
 * identity the editor actually adopted.
 */
const WORKSPACE_ID_EXPR = `
  (async () => {
    const p = window.__WB_PROBE
    const svc = await p.getService(p.IWorkspaceContextService)
    return svc.getWorkspace().id
  })()
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
 * Returns EVERY stored `editorpart.state` as one JSON array string, or `null`
 * when no bucket holds one. Every bucket, because after a switch there are two
 * (one per project) and the question being asked is "is this tab's state stored
 * anywhere", not "which bucket holds it" — the tab list is what proves the
 * incoming project does not read it. A substring match on that JSON is
 * deliberate: `FileEditorInput` serializes to a nested JSON *string*
 * (fileEditorHandler.js:27), so a structural walk over the grid would step
 * right past the resources. Enumerating databases instead of recomputing the
 * workspace id keeps this honest — it reports what is actually stored.
 */
const READ_PERSISTED_EDITOR_STATE_EXPR = `
  (async () => {
    const dbs = await indexedDB.databases()
    const names = dbs.map((d) => d.name).filter((n) => n && n.startsWith('vscode-web-state-db-'))
    const states = []
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
      if (state) states.push(state)
    }
    return states.length > 0 ? JSON.stringify(states) : null
  })()
`

async function listWorkbenchTabPaths(electronApp: ElectronApplication): Promise<string[]> {
  return runInWorkbench<string[]>(electronApp, LIST_TAB_PATHS_EXPR)
}

test.describe('embedded workbench: project switch discards stale restored tabs', () => {
  test.setTimeout(300_000)

  // The spec ends on the tabbar app's window, and a workbench window left open
  // outlives the file into later specs in the same worker: helpers that pick
  // "the first simulator" or "the first workbench" would then read this
  // project instead of theirs. Both projects are named because a failure
  // partway through can leave either one — or both — still open; naming one
  // that is already closed matches no window and does nothing.
  //
  // A close that fails is reported, not swallowed: `closeProject` only throws
  // when a window it targeted is STILL open 30s later, which is precisely the
  // leak this hook exists to prevent. Both are attempted before anything is
  // raised, so a stuck demo-app window cannot leave the tabbar one behind too.
  test.afterEach(async ({ electronApp }) => {
    const failures: unknown[] = []
    for (const projectDir of [DEMO_APP_DIR, TABBAR_APP_DIR]) {
      try {
        await closeProject(electronApp, { projectDir })
      } catch (err) {
        failures.push(err)
      }
    }
    if (failures.length > 0) {
      throw new Error(failures.map((err) => (err instanceof Error ? err.message : String(err))).join('; '))
    }
  })

  test('a tab persisted by the previous project must not strand a not-found editor after switching', async ({
    electronApp,
  }) => {
    // 1) Open the demo app and bring the embedded workbench up. `openProjectInUI`
    // opens its own workbench window (it never reuses/replaces another
    // project's) and returns that window's Page directly.
    const workbench1 = await openProjectInUI(electronApp, DEMO_APP_DIR, { waitMs: 60_000 })
    const status = await attachWorkbenchAndWaitReady(workbench1, electronApp)
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

    // 3) Sit on the storage flush window until the demo app's editor state is
    // actually on disk. This is an assertion, not a wait: if nothing persists,
    // step 5 can only pass vacuously (an earlier iteration of this spec did
    // exactly that), and the project would also have lost the per-miniapp
    // editor restore this fix is supposed to give it.
    const persisted = await pollUntil(
      () => runInWorkbench<string | null>(electronApp, READ_PERSISTED_EDITOR_STATE_EXPR),
      (state) => typeof state === 'string' && state.includes('storage-test'),
      FLUSH_WINDOW_MS,
      1000,
    ).catch(() => null)
    expect(
      persisted,
      "the demo app's open tab must reach its own WORKSPACE-scope storage — otherwise the switch below proves nothing",
    ).toContain('storage-test')

    // 4) Switch to a project that does NOT contain that file. Under the
    // per-project workbench window model, "switching" means closing the demo
    // app's window (there is no more in-place replace) before opening the
    // next one — otherwise both windows' embedded workbench WCVs would coexist
    // and `runInWorkbench`'s app-wide first-match probe could hit either one,
    // making every assertion below nondeterministic. Closing first also
    // matches the docstring's premise: the OLD WebContentsView is destroyed
    // and a fresh one boots, restoring whatever its own workspace id points at
    // — a DIFFERENT bucket, because the id is derived from the miniapp rather
    // than from the shared mirror root.
    const idBefore = await runInWorkbench<string | null>(electronApp, WORKSPACE_ID_EXPR)
    await closeProject(electronApp, { projectDir: DEMO_APP_DIR })
    const workbench2 = await openProjectInUI(electronApp, TABBAR_APP_DIR, { waitMs: 60_000 })
    const status2 = await attachWorkbenchAndWaitReady(workbench2, electronApp)
    expect(status2, 'workbench must reach a ready status after switching projects').toMatch(
      /workbench-ready|exthost-alive/,
    )
    const idAfter = await runInWorkbench<string | null>(electronApp, WORKSPACE_ID_EXPR)
    expect(idBefore, 'the demo app workbench must be given a workspace id').toBeTruthy()
    expect(idAfter, 'the tabbar app workbench must be given a workspace id').toBeTruthy()
    expect(idAfter, 'two projects must not share a workspace id').not.toBe(idBefore)

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

    // 6) …and it stayed absent because the two projects look at different
    // buckets, not because the state was thrown away: the demo app's memento is
    // still there for when the user switches back.
    const stillPersisted = await runInWorkbench<string | null>(electronApp, READ_PERSISTED_EDITOR_STATE_EXPR)
    expect(
      stillPersisted,
      "the previous project's editor state must survive the switch (isolated, not discarded)",
    ).toContain('storage-test')

    // 7) The user-visible symptom, independent of how the tab list reads.
    const notFound = await runInWorkbench<boolean>(electronApp, NOT_FOUND_VISIBLE_EXPR)
    expect(notFound, 'no "file was not found" placeholder should be visible after the switch').toBe(false)
  })
})
