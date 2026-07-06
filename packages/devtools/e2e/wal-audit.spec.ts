/**
 * fs-core WAL audit ledger, end-to-end against the real embedded VS Code
 * workbench (devtools-fs-core-feasibility.md §6): the human save path stays
 * disk-first/ledger-second, and the (host-programmatic, no UI yet) agent turn
 * surface gates disk writes through fs-core before replaying them.
 *
 * Drives `window.__WB_AUDIT` (see main.ts) the same way qdml-filetypes.spec.ts
 * drives `window.__WB_PROBE` — find the workbench WebContentsView by polling
 * for `window.__WB_STATUS`, then `executeJavaScript` against it.
 */
import fs from 'fs'
import path from 'path'
import { test, expect } from './fixtures'
import { DEMO_APP_DIR, openProjectInUI, closeProject, pollUntil } from './helpers'
import { runInWorkbench, attachWorkbenchAndWaitReady } from './workbench-probe'

test.describe('fs-core WAL audit ledger (embedded workbench)', () => {
  test.setTimeout(180_000)

  test.beforeEach(async ({ mainWindow, electronApp }) => {
    await openProjectInUI(mainWindow, DEMO_APP_DIR, { waitMs: 60_000 })
    const status = await attachWorkbenchAndWaitReady(mainWindow, electronApp)
    expect(status, 'workbench must reach a ready status before driving __WB_AUDIT').toMatch(
      /workbench-ready|exthost-alive/,
    )
    // populateWorkspace (and therefore the WAL ledger init it triggers) is awaited
    // before boot.ts reports 'workbench-ready', so __WB_AUDIT is already installed
    // (init may have degraded — this only proves the wrapper itself is wired, not
    // that OPFS actually came up; the tests below prove that separately).
    const hasAudit = await runInWorkbench<boolean>(electronApp, 'typeof window.__WB_AUDIT !== "undefined"')
    expect(hasAudit, 'main.ts must install window.__WB_AUDIT alongside the workspace source').toBe(true)
  })

  test.afterEach(async ({ mainWindow }) => {
    await closeProject(mainWindow)
  })

  test('human save: editing through the real file service updates disk and advances the fs-core ledger gen', async ({
    electronApp,
  }) => {
    const wxmlPath = path.join(DEMO_APP_DIR, 'pages', 'index', 'index.wxml')
    const original = fs.readFileSync(wxmlPath, 'utf8')
    const marker = `E2E_WAL_HUMAN_${Date.now()}`

    try {
      const before = await runInWorkbench<{ walGen: number }>(electronApp, 'window.__WB_AUDIT.status()')

      const mutated = original + `\n<!-- ${marker} -->`
      // Write through the SAME file service the real Monaco save flow uses
      // (window.__WB_PROBE is exposed via bootWorkbench's exposeProbe:true) —
      // this exercises the onDidRunOperation → WorkspaceSource.onSave listener
      // installed in boot.ts, not a filesystem shortcut.
      await runInWorkbench(
        electronApp,
        `(async () => {
          const p = window.__WB_PROBE
          const fileService = await p.getService(p.IFileService)
          const uri = p.URI.parse('file:///workspace/pages/index/index.wxml')
          await fileService.writeFile(uri, p.VSBuffer.fromString(${JSON.stringify(mutated)}))
        })()`,
      )

      // The onSave listener flushes to disk asynchronously (fire-and-forget from
      // the file service's perspective), so poll disk content rather than assume
      // writeFile()'s own promise ordering.
      await pollUntil(
        () => Promise.resolve(fs.existsSync(wxmlPath) ? fs.readFileSync(wxmlPath, 'utf8') : ''),
        (t) => t.includes(marker),
        20_000,
        300,
      )
      expect(fs.readFileSync(wxmlPath, 'utf8'), 'disk must contain the saved marker').toContain(marker)

      const after = await pollUntil(
        () => runInWorkbench<{ walGen: number }>(electronApp, 'window.__WB_AUDIT.status()'),
        (s) => s.walGen > before.walGen,
        20_000,
        300,
      )
      expect(after.walGen, 'fs-core ledger walGen must advance past the pre-save gen').toBeGreaterThan(before.walGen)
    } finally {
      fs.writeFileSync(wxmlPath, original, 'utf8')
    }
  })

  test('agent turn: agentWrite is disk-visible, rollback restores the pre-turn state', async ({ electronApp }) => {
    const rel = 'pages/index/e2e-wal-agent.txt'
    const absPath = path.join(DEMO_APP_DIR, rel)
    const turnId = `t-e2e-${Date.now()}`
    const marker = `E2E_WAL_AGENT_${Date.now()}`

    try {
      if (fs.existsSync(absPath)) fs.unlinkSync(absPath)

      await runInWorkbench(electronApp, `window.__WB_AUDIT.beginTurn(${JSON.stringify(turnId)})`)
      await runInWorkbench(
        electronApp,
        `window.__WB_AUDIT.agentWrite(${JSON.stringify(rel)}, ${JSON.stringify(marker)}, ${JSON.stringify(turnId)})`,
      )

      await pollUntil(
        () => Promise.resolve(fs.existsSync(absPath) ? fs.readFileSync(absPath, 'utf8') : null),
        (t) => t === marker,
        20_000,
        300,
      )
      expect(fs.existsSync(absPath), 'agentWrite must be visible on disk (replayed through the /__fs bridge)').toBe(
        true,
      )
      expect(fs.readFileSync(absPath, 'utf8')).toBe(marker)

      await runInWorkbench(electronApp, `window.__WB_AUDIT.rollback(${JSON.stringify(turnId)})`)

      await pollUntil(
        () => Promise.resolve(!fs.existsSync(absPath)),
        (gone) => gone === true,
        20_000,
        300,
      )
      expect(
        fs.existsSync(absPath),
        'rollback must remove the file the turn created (it did not exist before turnBegin)',
      ).toBe(false)
    } finally {
      if (fs.existsSync(absPath)) fs.unlinkSync(absPath)
    }
  })
})
