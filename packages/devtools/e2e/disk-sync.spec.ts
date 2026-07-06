/**
 * fs-core disk↔editor sync engine, end-to-end against the real embedded VS
 * Code workbench (devtools-fs-core-feasibility.md §7): an external disk write
 * or delete must reach the live editor buffer through the `/__fs/watch` SSE
 * stream, and a human save must not double-advance the ledger via its own
 * watcher echo.
 *
 * Drives `window.__WB_AUDIT`/`window.__WB_PROBE` the same way wal-audit.spec.ts
 * does — find the workbench WebContentsView by polling for
 * `window.__WB_STATUS`, then `executeJavaScript` against it.
 */
import fs from 'fs'
import path from 'path'
import { test, expect } from './fixtures'
import { DEMO_APP_DIR, openProjectInUI, closeProject, pollUntil } from './helpers'
import { runInWorkbench, attachWorkbenchAndWaitReady } from './workbench-probe'

/** Read a workspace-relative file's content through the SAME `IFileService`
 * the real editor uses; `null` when the resource does not (or no longer)
 * exist, so a caller can poll for either a marker string or absence. Raced
 * against an in-page timeout: a service call that never settles (observed
 * once while a project open was still churning) would otherwise hang the
 * whole `executeJavaScript` — and with it the polling test — instead of just
 * costing one poll iteration. */
function readEditorContentExpr(rel: string): string {
  return `Promise.race([
    (async () => {
      const p = window.__WB_PROBE
      const fileService = await p.getService(p.IFileService)
      const uri = p.URI.parse('file:///workspace/' + ${JSON.stringify(rel)})
      try {
        const content = await fileService.readFile(uri)
        return content.value.toString()
      } catch (e) {
        return null
      }
    })(),
    new Promise((resolve) => setTimeout(() => resolve('__POLL_TIMEOUT__'), 5000)),
  ])`
}

test.describe('fs-core disk↔editor sync (embedded workbench)', () => {
  test.setTimeout(180_000)

  test.beforeEach(async ({ mainWindow, electronApp }) => {
    await openProjectInUI(mainWindow, DEMO_APP_DIR, { waitMs: 60_000 })
    const status = await attachWorkbenchAndWaitReady(mainWindow, electronApp)
    expect(status, 'workbench must reach a ready status before driving the sync engine').toMatch(
      /workbench-ready|exthost-alive/,
    )
  })

  test.afterEach(async ({ mainWindow }) => {
    await closeProject(mainWindow)
  })

  test('external write: an fs.writeFileSync on the active project updates the editor buffer and advances the ledger gen', async ({
    electronApp,
  }) => {
    const rel = 'pages/index/e2e-disk-sync-write.txt'
    const absPath = path.join(DEMO_APP_DIR, rel)
    const marker = `E2E_DISK_SYNC_WRITE_${Date.now()}`

    try {
      if (fs.existsSync(absPath)) fs.unlinkSync(absPath)
      const before = await runInWorkbench<{ walGen: number }>(electronApp, 'window.__WB_AUDIT.status()')

      fs.writeFileSync(absPath, marker, 'utf8')

      await pollUntil(
        () => runInWorkbench<string | null>(electronApp, readEditorContentExpr(rel)),
        (content) => content === marker,
        20_000,
        500,
      )

      const after = await pollUntil(
        () => runInWorkbench<{ walGen: number }>(electronApp, 'window.__WB_AUDIT.status()'),
        (s) => s.walGen > before.walGen,
        20_000,
        500,
      )
      expect(after.walGen, 'fs-core ledger walGen must advance past the pre-write gen').toBeGreaterThan(before.walGen)
    } finally {
      if (fs.existsSync(absPath)) fs.unlinkSync(absPath)
    }
  })

  test('external delete: removing a synced file makes it unreadable through the editor file service', async ({
    electronApp,
  }) => {
    const rel = 'pages/index/e2e-disk-sync-delete.txt'
    const absPath = path.join(DEMO_APP_DIR, rel)
    const marker = `E2E_DISK_SYNC_DELETE_${Date.now()}`

    try {
      if (fs.existsSync(absPath)) fs.unlinkSync(absPath)
      fs.writeFileSync(absPath, marker, 'utf8')

      // Wait for the create to round-trip into the editor first, so the
      // subsequent delete is a genuine "was there, now gone" transition
      // rather than a delete of a path the sync engine never observed.
      await pollUntil(
        () => runInWorkbench<string | null>(electronApp, readEditorContentExpr(rel)),
        (content) => content === marker,
        20_000,
        500,
      )

      fs.unlinkSync(absPath)

      await pollUntil(
        () => runInWorkbench<string | null>(electronApp, readEditorContentExpr(rel)),
        (content) => content === null,
        20_000,
        500,
      )
    } finally {
      if (fs.existsSync(absPath)) fs.unlinkSync(absPath)
    }
  })

  test('save echo consolidation: a human save does not double-advance the ledger via its own watcher echo', async ({
    electronApp,
  }) => {
    const wxmlPath = path.join(DEMO_APP_DIR, 'pages', 'index', 'index.wxml')
    const original = fs.readFileSync(wxmlPath, 'utf8')
    const marker = `E2E_DISK_SYNC_ECHO_${Date.now()}`

    try {
      const mutated = original + `\n<!-- ${marker} -->`
      await runInWorkbench(
        electronApp,
        `(async () => {
          const p = window.__WB_PROBE
          const fileService = await p.getService(p.IFileService)
          const uri = p.URI.parse('file:///workspace/pages/index/index.wxml')
          await fileService.writeFile(uri, p.VSBuffer.fromString(${JSON.stringify(mutated)}))
        })()`,
      )

      await pollUntil(
        () => Promise.resolve(fs.existsSync(wxmlPath) ? fs.readFileSync(wxmlPath, 'utf8') : ''),
        (t) => t.includes(marker),
        20_000,
        300,
      )

      // Generous margin over the server's 80ms debounce window for the
      // watcher round trip + echo comparison to settle before sampling gen.
      await new Promise((r) => setTimeout(r, 2000))
      const afterSave = await runInWorkbench<{ walGen: number }>(electronApp, 'window.__WB_AUDIT.status()')

      await new Promise((r) => setTimeout(r, 2000))
      const afterWait = await runInWorkbench<{ walGen: number }>(electronApp, 'window.__WB_AUDIT.status()')

      expect(
        afterWait.walGen,
        'ledger gen must not advance again once the save has settled — the watcher echo of our own save must be absorbed',
      ).toBe(afterSave.walGen)
    } finally {
      fs.writeFileSync(wxmlPath, original, 'utf8')
    }
  })
})
