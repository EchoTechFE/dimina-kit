/**
 * Embedded VS Code workbench, project switch: opening a file in one project
 * then switching to a different project destroys the old workbench view and
 * spawns a new one against the new workspace root. The new workbench restores
 * its editor tabs from persisted state before the new workspace is fully
 * reconciled, so a tab pointing at a path that only existed in the previous
 * project can resurrect transiently. The restored tab must not survive —
 * a tab whose URI does not resolve inside the current workspace gets closed
 * automatically once the workbench settles.
 */
import path from 'path'
import { fileURLToPath } from 'url'
import type { ElectronApplication } from '@playwright/test'
import { test, expect } from './fixtures'
import { DEMO_APP_DIR, openProjectInUI, pollUntil } from './helpers'
import { runInWorkbench, attachWorkbenchAndWaitReady } from './workbench-probe'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TABBAR_APP_DIR = path.join(__dirname, 'fixtures', 'tabbar-app')

/** Every open editor tab's underlying resource path (workspace-relative-free,
 * i.e. the raw `file://` path), across all tab groups. */
const LIST_TAB_PATHS_EXPR = `
  window.__WB_PROBE.vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .map((t) => (t.input && t.input.uri) ? t.input.uri.path : null)
    .filter(Boolean)
`

const STALE_TAB_PATH = '/workspace/pages/storage-test/storage-test.wxml'

async function listWorkbenchTabPaths(electronApp: ElectronApplication): Promise<string[]> {
  return runInWorkbench<string[]>(electronApp, LIST_TAB_PATHS_EXPR)
}

test.describe('embedded workbench: project switch discards stale restored tabs', () => {
  test.setTimeout(240_000)

  test('a tab restored from persisted state pointing at a file absent in the newly switched project gets closed', async ({
    mainWindow,
    electronApp,
  }) => {
    // 1) Open the demo app and bring the embedded workbench up.
    await openProjectInUI(mainWindow, DEMO_APP_DIR, { waitMs: 60_000 })
    let status = await attachWorkbenchAndWaitReady(mainWindow, electronApp)
    expect(status, 'workbench must reach a ready status for the first project').toMatch(
      /workbench-ready|exthost-alive/,
    )

    // 2) Open a file that exists only in the demo app, not in tabbar-app.
    await runInWorkbench(
      electronApp,
      `(async () => {
        const p = window.__WB_PROBE
        const uri = p.URI.parse('file://${STALE_TAB_PATH}')
        const doc = await p.vscode.workspace.openTextDocument(uri)
        await p.vscode.window.showTextDocument(doc)
        return true
      })()`,
    )

    await pollUntil(
      () => listWorkbenchTabPaths(electronApp),
      (paths) => paths.includes(STALE_TAB_PATH),
      20_000,
      500,
    )

    // 3) Blur the workbench (click the host window) so its storage layer
    // flushes the open-tabs state it will restore from on next boot.
    await mainWindow.click('body')
    await new Promise((r) => setTimeout(r, 2000))

    // 4) Switch to a different project. This destroys the current workbench
    // WebContentsView and boots a fresh one against tabbar-app's workspace.
    await openProjectInUI(mainWindow, TABBAR_APP_DIR, { waitMs: 60_000 })
    status = await attachWorkbenchAndWaitReady(mainWindow, electronApp)
    expect(status, 'workbench must reach a ready status after switching projects').toMatch(
      /workbench-ready|exthost-alive/,
    )

    // 5) The restored tab may transiently reappear (restore races the
    // workspace-mismatch sweep), so poll for its absence rather than
    // asserting immediately — only a timeout without ever losing it is a
    // genuine failure.
    const finalPaths = await pollUntil(
      () => listWorkbenchTabPaths(electronApp),
      (paths) => !paths.includes(STALE_TAB_PATH),
      10_000,
      300,
    )

    expect(
      finalPaths,
      `a tab pointing at ${STALE_TAB_PATH} (only present in the previous project) must not survive a project switch to tabbar-app; observed tabs: ${JSON.stringify(finalPaths)}`,
    ).not.toContain(STALE_TAB_PATH)
  })
})
