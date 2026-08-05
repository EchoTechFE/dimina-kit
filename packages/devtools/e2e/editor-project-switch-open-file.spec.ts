/**
 * Embedded VS Code workbench, project switch + open file: a user suspicion is
 * that opening a file FAILS ("The editor could not be opened because the file
 * was not found.") specifically around a project switch. The editor reads every
 * project file from an in-memory mirror (`file:///workspace`) populated once per
 * workbench boot from the COI `/__fs` disk bridge. The mirror is a *cache*, not
 * the source of truth — and a cache can be empty or partial at the exact moment
 * a file is opened (the post-switch re-boot, or the first-compile window).
 *
 * Two scenarios are pinned:
 *
 *  1. SETTLED switch — after switching to project B and waiting for the workbench
 *     to reach a ready status (emitted only AFTER the mirror population completes),
 *     B's real files must be openable with content and no stuck "not found" placeholder.
 *     This is the happy-path the user ends up seeing; it guards that a switch does
 *     not leave the editor pointed at the wrong/empty project.
 *
 *  2. DISK FALLBACK — opens a file that exists on disk but is NOT in the
 *     in-memory mirror (the mirror already ran at boot, so a file created afterward
 *     is exactly the "cache miss" the post-switch gap produces). With the
 *     disk-fallback `file://` provider wired in boot.ts, the open falls back to the
 *     `/__fs` bridge and resolves; without it, the open throws FILE_NOT_FOUND and
 *     the placeholder sticks. This reproduces the reported bug deterministically,
 *     independent of timing.
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { test, expect } from './fixtures'
import { DEMO_APP_DIR, openProjectInUI, pollUntil } from './helpers'
import { runInWorkbench, attachWorkbenchAndWaitReady } from './workbench-probe'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TABBAR_APP_DIR = path.join(__dirname, 'fixtures', 'tabbar-app')

const B_FILE_REL = 'pages/home/home.js'
const B_FILE_URI = `file:///workspace/${B_FILE_REL}`

/** Whether the re-mirrored memfs contains the given workspace-relative file. */
const FILE_EXISTS_EXPR = `
  (async () => {
    const p = window.__WB_PROBE
    if (!p) return { ok: false, reason: 'no probe' }
    const uri = p.URI.parse(${JSON.stringify(B_FILE_URI)})
    const fs = await p.getService(p.IFileService)
    return { ok: true, exists: await fs.exists(uri) }
  })()
`

/** Open the file the way the product does (openTextDocument + showTextDocument)
 * and report the active editor's identity + whether a "not found" placeholder
 * took over. */
const OPEN_AND_INSPECT_EXPR = `
  (async () => {
    const p = window.__WB_PROBE
    if (!p) return { opened: false, reason: 'no probe' }
    const uri = p.URI.parse(${JSON.stringify(B_FILE_URI)})
    try {
      const doc = await p.vscode.workspace.openTextDocument(uri)
      const ed = await p.vscode.window.showTextDocument(doc)
      const activePath = p.vscode.window.activeTextEditor
        ? p.vscode.window.activeTextEditor.document.uri.path
        : null
      const text = doc.getText()
      return {
        opened: true,
        activePath,
        hasContent: /Page\\(|pageName/.test(text),
        len: text.length,
      }
    } catch (e) {
      return { opened: false, reason: String((e && e.message) || e) }
    }
  })()
`

/** True when a "file was not found" placeholder is on screen in the workbench. */
const NOT_FOUND_VISIBLE_EXPR = `
  (() => {
    const t = document.body.innerText || ''
    return /could not be opened because the file was not found/i.test(t)
  })()
`

test.describe('embedded workbench: open a file after switching projects', () => {
  test.setTimeout(240_000)

  test('switching to project B then opening one of B\'s files does not report "file was not found"', async ({
    mainWindow,
    electronApp,
  }) => {
    // 1) Open the first project and bring the workbench up.
    await openProjectInUI(mainWindow, DEMO_APP_DIR, { waitMs: 60_000 })
    let status = await attachWorkbenchAndWaitReady(mainWindow, electronApp)
    expect(status, 'workbench must reach a ready status for the first project').toMatch(
      /workbench-ready|exthost-alive/,
    )

    // 2) Sanity: a file opens fine in the first project (proves open works pre-switch).
    const before = await runInWorkbench<{ opened: boolean; reason?: string }>(
      electronApp,
      OPEN_AND_INSPECT_EXPR.replace(B_FILE_URI, 'file:///workspace/pages/index/index.js'),
    ).catch(() => ({ opened: false, reason: 'probe failed' }))
    expect(before.opened, `a demo-app file should open before switching; got=${JSON.stringify(before)}`).toBe(true)

    // 3) Switch to a different project. This destroys the current workbench
    // WebContentsView and boots a fresh one that must re-mirror tabbar-app.
    await openProjectInUI(mainWindow, TABBAR_APP_DIR, { waitMs: 60_000 })
    status = await attachWorkbenchAndWaitReady(mainWindow, electronApp)
    expect(status, 'workbench must reach a ready status after switching projects').toMatch(
      /workbench-ready|exthost-alive/,
    )

    // 4) The re-mirror must contain B's real files. If the switch re-mirrored
    // the wrong/empty project, B's file is absent from the memfs and every
    // open of it would report "file was not found".
    const exists = await runInWorkbench<{ ok: boolean; exists?: boolean; reason?: string }>(
      electronApp,
      FILE_EXISTS_EXPR,
    )
    expect(exists.ok, `mirror probe must run; got=${JSON.stringify(exists)}`).toBe(true)
    expect(
      exists.exists,
      `after switching to tabbar-app, ${B_FILE_REL} must be present in the re-mirrored workspace; got=${JSON.stringify(exists)}`,
    ).toBe(true)

    // 5) Opening B's file must reveal its content, not a "not found" placeholder.
    const opened = await pollUntil(
      () =>
        runInWorkbench<{ opened: boolean; activePath?: string | null; hasContent?: boolean; reason?: string }>(
          electronApp,
          OPEN_AND_INSPECT_EXPR,
        ).catch(() => ({ opened: false, reason: 'probe failed' })),
      (r) => r.opened === true,
      20_000,
      400,
    )
    expect(
      opened.opened,
      `opening ${B_FILE_REL} after switching must succeed; got=${JSON.stringify(opened)}`,
    ).toBe(true)
    expect(
      opened.activePath,
      `the active editor must be ${B_FILE_REL}; got=${JSON.stringify(opened)}`,
    ).toBe('/workspace/pages/home/home.js')
    expect(
      opened.hasContent,
      `the opened ${B_FILE_REL} must show real source (Page(...)), not an error placeholder; got=${JSON.stringify(opened)}`,
    ).toBe(true)

    const notFound = await runInWorkbench<boolean>(electronApp, NOT_FOUND_VISIBLE_EXPR)
    expect(
      notFound,
      `no "file was not found" placeholder should be visible after opening ${B_FILE_REL}`,
    ).toBe(false)
  })

  test('opening a file that is on disk but missing from the in-memory mirror falls back to disk', async ({
    mainWindow,
    electronApp,
  }) => {
    // This reproduces the reported bug deterministically: the in-memory mirror is
    // populated once at boot, so a file written to disk afterward is exactly the
    // "cache miss" a post-switch re-boot produces. Without the disk-fallback
    // provider the open throws FILE_NOT_FOUND; with it, the open reads from the
    // `/__fs` bridge and resolves.
    await openProjectInUI(mainWindow, DEMO_APP_DIR, { waitMs: 60_000 })
    const status = await attachWorkbenchAndWaitReady(mainWindow, electronApp)
    expect(status, 'workbench must reach a ready status before the disk-fallback open').toMatch(
      /workbench-ready|exthost-alive/,
    )

    const marker = `__E2E_DISK_FALLBACK_MARKER__${Date.now()}`
    const rel = '__e2e_disk_fallback__.js'
    const abs = path.join(DEMO_APP_DIR, rel)
    fs.writeFileSync(abs, `// ${marker}\nPage({ data: {} })\n`)

    const OPEN_FALLBACK_EXPR = `
      (async () => {
        const p = window.__WB_PROBE
        if (!p) return { opened: false, reason: 'no probe' }
        const uri = p.URI.parse(${JSON.stringify(`file:///workspace/${rel}`)})
        try {
          const doc = await p.vscode.workspace.openTextDocument(uri)
          await p.vscode.window.showTextDocument(doc)
          const text = doc.getText()
          return {
            opened: true,
            activePath: p.vscode.window.activeTextEditor
              ? p.vscode.window.activeTextEditor.document.uri.path
              : null,
            hasMarker: text.includes(${JSON.stringify(marker)}),
          }
        } catch (e) {
          return { opened: false, reason: String((e && e.message) || e) }
        }
      })()
    `

    try {
      const res = await pollUntil(
        () =>
          runInWorkbench<{ opened: boolean; activePath?: string | null; hasMarker?: boolean; reason?: string }>(
            electronApp,
            OPEN_FALLBACK_EXPR,
          ).catch(() => ({ opened: false, reason: 'probe failed' })),
        (r) => r.opened === true,
        20_000,
        400,
      )
      expect(res.opened, `opening the disk-only file must succeed via fallback; got=${JSON.stringify(res)}`).toBe(true)
      expect(
        res.activePath,
        `the active editor must be /workspace/${rel}; got=${JSON.stringify(res)}`,
      ).toBe(`/workspace/${rel}`)
      expect(
        res.hasMarker,
        `the opened file must carry the disk marker (served from /__fs, not the mirror); got=${JSON.stringify(res)}`,
      ).toBe(true)

      const notFound = await runInWorkbench<boolean>(electronApp, NOT_FOUND_VISIBLE_EXPR)
      expect(notFound, 'no "file was not found" placeholder should be visible for the disk-only file').toBe(false)
    } finally {
      // Remove the disk-only probe file so it cannot leak into the per-worker
      // project copy or a later run.
      fs.rmSync(abs, { force: true })
    }
  })
})
