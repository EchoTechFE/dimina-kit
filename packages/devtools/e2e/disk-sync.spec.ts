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
import { test, expect, useSharedProject } from './fixtures'
import { DEMO_APP_DIR, pollUntil } from './helpers'
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

/** Same contract as {@link readEditorContentExpr} but for a binary file: reads
 * the resource through `IFileService` and returns the raw bytes base64-encoded
 * (so the test can compare byte-for-byte without decoding through UTF-8,
 * which would corrupt NUL/non-UTF-8 content), or `null` when absent. */
function readEditorBytesBase64Expr(rel: string): string {
  return `Promise.race([
    (async () => {
      const p = window.__WB_PROBE
      const fileService = await p.getService(p.IFileService)
      const uri = p.URI.parse('file:///workspace/' + ${JSON.stringify(rel)})
      try {
        const content = await fileService.readFile(uri)
        const bytes = content.value.buffer
        let bin = ''
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
        return btoa(bin)
      } catch (e) {
        return null
      }
    })(),
    new Promise((resolve) => setTimeout(() => resolve('__POLL_TIMEOUT__'), 5000)),
  ])`
}

test.describe('fs-core disk↔editor sync (embedded workbench)', () => {
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
    expect(status, 'workbench must reach a ready status before driving the sync engine').toMatch(
      /workbench-ready|exthost-alive/,
    )
    workbenchReady = true
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

  test('bulk external churn: 200 files created then deleted externally all reconcile into and out of the editor', async ({
    electronApp,
  }) => {
    const BULK_N = 200
    const bulkDir = path.join(DEMO_APP_DIR, 'pages', 'index', 'e2e-bulk')
    // Counts (inside the page, one round trip) how many of the N bulk files
    // are readable through the editor's own IFileService with the expected
    // content — the same service every other assertion in this file uses.
    const countExpr = (n: number) => `Promise.race([
      (async () => {
        const p = window.__WB_PROBE
        const fileService = await p.getService(p.IFileService)
        let present = 0
        for (let i = 0; i < ${n}; i++) {
          const uri = p.URI.parse('file:///workspace/pages/index/e2e-bulk/f' + i + '.txt')
          try {
            const c = await fileService.readFile(uri)
            if (c.value.toString() === 'bulk ' + i) present++
          } catch (e) { /* not (yet) present */ }
        }
        return present
      })(),
      new Promise((resolve) => setTimeout(() => resolve(-1), 15000)),
    ])`

    try {
      fs.rmSync(bulkDir, { recursive: true, force: true })
      const before = await runInWorkbench<{ walGen: number }>(electronApp, 'window.__WB_AUDIT.status()')

      fs.mkdirSync(bulkDir, { recursive: true })
      for (let i = 0; i < BULK_N; i++) fs.writeFileSync(path.join(bulkDir, `f${i}.txt`), `bulk ${i}`, 'utf8')

      const landed = await pollUntil(
        () => runInWorkbench<number>(electronApp, countExpr(BULK_N)),
        (n) => n === BULK_N,
        60_000,
        1000,
      )
      expect(landed, `all ${BULK_N} externally created files must reach the editor`).toBe(BULK_N)

      const after = await runInWorkbench<{ walGen: number }>(electronApp, 'window.__WB_AUDIT.status()')
      expect(after.walGen, 'the ledger must have recorded the bulk batch').toBeGreaterThan(before.walGen)

      fs.rmSync(bulkDir, { recursive: true })
      const gone = await pollUntil(
        () => runInWorkbench<number>(electronApp, countExpr(BULK_N)),
        (n) => n === 0,
        60_000,
        1000,
      )
      expect(gone, 'all bulk files must leave the editor after the external recursive delete').toBe(0)
    } finally {
      fs.rmSync(bulkDir, { recursive: true, force: true })
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
      // Wait for the restore itself to round-trip through the watcher before
      // the test ends — otherwise its ledger write can still be in flight
      // (past the 80ms debounce) when the NEXT test starts, and that test
      // would misread this cleanup's gen bump as its own.
      await pollUntil(
        () => runInWorkbench<string | null>(electronApp, readEditorContentExpr('pages/index/index.wxml')),
        (content) => content === original,
        20_000,
        500,
      ).catch(() => {}) // best-effort: never fail the test on cleanup-settling timeout
    }
  })

  test('external binary write: a NUL-containing file round-trips byte-for-byte into the editor without advancing the WAL gen', async ({
    electronApp,
  }) => {
    const rel = 'pages/index/e2e-disk-sync-binary.bin'
    const absPath = path.join(DEMO_APP_DIR, rel)
    // A small binary blob: NUL byte first (well within the engine's 8192-byte
    // sniff window), plus a spread of non-UTF-8-safe byte values.
    const bytes = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a])
    const expectedBase64 = bytes.toString('base64')

    try {
      if (fs.existsSync(absPath)) fs.unlinkSync(absPath)
      const before = await runInWorkbench<{ walGen: number }>(electronApp, 'window.__WB_AUDIT.status()')

      fs.writeFileSync(absPath, bytes)

      await pollUntil(
        () => runInWorkbench<string | null>(electronApp, readEditorBytesBase64Expr(rel)),
        (b64) => b64 === expectedBase64,
        20_000,
        500,
      )

      // Binary content never enters the fs-core ledger (packages/fs-core/sync
      // binary layering) — the WAL gen must NOT advance because of it, unlike
      // the analogous text write test above.
      await new Promise((r) => setTimeout(r, 2000))
      const after = await runInWorkbench<{ walGen: number }>(electronApp, 'window.__WB_AUDIT.status()')
      expect(after.walGen, 'a binary write must not advance the fs-core ledger WAL gen').toBe(before.walGen)
    } finally {
      if (fs.existsSync(absPath)) fs.unlinkSync(absPath)
    }
  })
})
