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
import { test, expect, useSharedProject } from './fixtures'
import { DEMO_APP_DIR, pollUntil } from './helpers'
import { runInWorkbench, attachWorkbenchAndWaitReady } from './workbench-probe'

test.describe('fs-core WAL audit ledger (embedded workbench)', () => {
  test.setTimeout(180_000)

  // Open the project ONCE for the whole file (worker-scoped Electron is
  // already shared); each per-test open/close cost a full open+workbench-ready
  // cycle (~40-60s each). Workbench readiness is likewise per-open, so only
  // the first test pays the attach+ready wait.
  useSharedProject(test, DEMO_APP_DIR, { openOptions: { waitMs: 60_000 }, openTimeoutMs: 120_000 })
  let workbenchReady = false
  test.beforeEach(async ({ mainWindow, electronApp }) => {
    if (workbenchReady) return
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
    workbenchReady = true
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

      // With the shared project, the previous test's disk-restore is still
      // washing through the sync engine as human ledger writes; one landing
      // after turnBegin's checkpoint makes fs-core's restore-conflict check
      // (correctly) reject the rollback ("human edits since baseGen"). Wait
      // for the ledger to go quiet before opening the turn.
      await pollUntil(
        async () => {
          const a = await runInWorkbench<{ walGen: number }>(electronApp, 'window.__WB_AUDIT.status()')
          await new Promise((r) => setTimeout(r, 1200))
          const b = await runInWorkbench<{ walGen: number }>(electronApp, 'window.__WB_AUDIT.status()')
          return a.walGen === b.walGen
        },
        (quiet) => quiet === true,
        30_000,
        100,
      )

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
      // rollback does NOT close the turn — leave it open and the next test's
      // beginTurn fails with "a turn is already active".
      await runInWorkbench(electronApp, `window.__WB_AUDIT.endTurn(${JSON.stringify(turnId)}).catch(() => {})`)
      if (fs.existsSync(absPath)) fs.unlinkSync(absPath)
    }
  })

  test('agent turn under external write storm: rollback is protectively refused, agent and external writes both intact', async ({
    electronApp,
  }) => {
    const STORM_N = 30
    const agentRel = 'pages/index/e2e-storm-agent.txt'
    const agentAbs = path.join(DEMO_APP_DIR, agentRel)
    const stormDir = path.join(DEMO_APP_DIR, 'pages', 'index', 'e2e-storm')
    const turnId = `t-e2e-storm-${Date.now()}`
    const marker = `E2E_STORM_AGENT_${Date.now()}`

    try {
      if (fs.existsSync(agentAbs)) fs.unlinkSync(agentAbs)
      fs.rmSync(stormDir, { recursive: true, force: true })

      // Same ledger-quiescence precondition as the plain agent-turn test above.
      await pollUntil(
        async () => {
          const a = await runInWorkbench<{ walGen: number }>(electronApp, 'window.__WB_AUDIT.status()')
          await new Promise((r) => setTimeout(r, 1200))
          const b = await runInWorkbench<{ walGen: number }>(electronApp, 'window.__WB_AUDIT.status()')
          return a.walGen === b.walGen
        },
        (quiet) => quiet === true,
        30_000,
        100,
      )

      await runInWorkbench(electronApp, `window.__WB_AUDIT.beginTurn(${JSON.stringify(turnId)})`)
      await runInWorkbench(
        electronApp,
        `window.__WB_AUDIT.agentWrite(${JSON.stringify(agentRel)}, ${JSON.stringify(marker)}, ${JSON.stringify(turnId)})`,
      )
      await pollUntil(
        () => Promise.resolve(fs.existsSync(agentAbs) ? fs.readFileSync(agentAbs, 'utf8') : null),
        (t) => t === marker,
        20_000,
        300,
      )

      // External storm lands INSIDE the open turn window, as human ledger writes.
      fs.mkdirSync(stormDir, { recursive: true })
      for (let i = 0; i < STORM_N; i++) fs.writeFileSync(path.join(stormDir, `s${i}.txt`), `storm ${i}`, 'utf8')
      const stormLandedGen = await pollUntil(
        () => runInWorkbench<{ walGen: number }>(electronApp, 'window.__WB_AUDIT.status()'),
        (s) => s.walGen > 0,
        20_000,
        500,
      )
      // Wait for the storm to fully wash through (ledger quiet again) so the
      // rollback below races nothing.
      await pollUntil(
        async () => {
          const a = await runInWorkbench<{ walGen: number }>(electronApp, 'window.__WB_AUDIT.status()')
          await new Promise((r) => setTimeout(r, 1200))
          const b = await runInWorkbench<{ walGen: number }>(electronApp, 'window.__WB_AUDIT.status()')
          return a.walGen === b.walGen
        },
        (quiet) => quiet === true,
        30_000,
        100,
      )
      expect(stormLandedGen.walGen).toBeGreaterThan(0)

      // fs-core's restore-conflict check refuses to roll back over human
      // ledger writes that landed after the turn's checkpoint — with 30
      // external files recorded inside the window, the rollback MUST be
      // refused rather than partially unwinding a tree the human (external
      // truth) has since moved.
      const rollback = await runInWorkbench<{ ok: boolean; message?: string }>(
        electronApp,
        `(async () => {
          try {
            await window.__WB_AUDIT.rollback(${JSON.stringify(turnId)})
            return { ok: true }
          } catch (e) {
            return { ok: false, message: String((e && (e.message || e)) || 'unknown') }
          }
        })()`,
      )
      expect(rollback.ok, `rollback over ${STORM_N} interleaved human writes must be refused (got: ${JSON.stringify(rollback)})`).toBe(false)

      // Protective refusal means NOTHING was unwound: the agent's file and
      // every storm file are still exactly where they were.
      expect(fs.readFileSync(agentAbs, 'utf8'), 'agent write must survive the refused rollback').toBe(marker)
      for (let i = 0; i < STORM_N; i++) {
        expect(fs.readFileSync(path.join(stormDir, `s${i}.txt`), 'utf8')).toBe(`storm ${i}`)
      }
    } finally {
      await runInWorkbench(electronApp, `window.__WB_AUDIT.endTurn(${JSON.stringify(turnId)}).catch(() => {})`)
      fs.rmSync(stormDir, { recursive: true, force: true })
      if (fs.existsSync(agentAbs)) fs.unlinkSync(agentAbs)
    }
  })
})
