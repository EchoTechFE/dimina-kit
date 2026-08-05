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
 *  2. DISK FALLBACK — empties the mirror entry for a real on-disk file, then
 *     reads it immediately and asserts the `/__fs/read` bridge was actually hit.
 *     Proves the bytes came from disk, not from the (now-empty) memfs and not
 *     from the disk→memfs watcher (a memfs delete is not a disk event, so the
 *     watcher never re-adds it). Without the fallback installed the read throws
 *     FILE_NOT_FOUND — so this fails red when the fallback is broken, unlike a
 *     naive "write to disk then poll" test that the watcher would mask.
 *     The bridge hit is counted via resource timing rather than by wrapping
 *     `window.fetch`, which destabilizes the workbench page under CDP.
 */
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

  test('opening a file that is missing from the in-memory mirror falls back to disk', async ({
    mainWindow,
    electronApp,
  }) => {
    // Reproduces the reported bug deterministically WITHOUT depending on the
    // disk→memfs watcher (which would mask a broken fallback: a file written to
    // disk after boot is mirrored into memfs by the watcher, so it would open
    // even if the fallback were dead). Instead we empty the mirror entry for a
    // real on-disk file, open it immediately, and assert the `/__fs/read`
    // bridge was actually hit — proving the open came from disk, not from the
    // memfs (now empty) and not from the watcher (a memfs delete is not a disk
    // event, so the watcher never re-adds it).
    await openProjectInUI(mainWindow, DEMO_APP_DIR, { waitMs: 60_000 })
    const status = await attachWorkbenchAndWaitReady(mainWindow, electronApp)
    expect(status, 'workbench must reach a ready status before the disk-fallback open').toMatch(
      /workbench-ready|exthost-alive/,
    )

    const rel = 'pages/index/index.js'

    const OPEN_FALLBACK_EXPR = `
      (async () => {
        try {
          const p = window.__WB_PROBE
          if (!p) return { opened: false, reason: 'no probe' }
          const uri = p.URI.parse(${JSON.stringify(`file:///workspace/${rel}`)})
          const fs = await p.getService(p.IFileService)
          // Sanity: the file is in the in-memory mirror before we empty it.
          const existedBefore = await fs.exists(uri)
          // Empty the mirror entry for this file ONLY; the on-disk copy stays.
          // (The disk→memfs watcher only fires on real disk events, and a memfs
          // delete is not one, so it will not silently re-add the entry.)
          try { await fs.del(uri) } catch (e) {}
          // Timestamp the boundary so we only count bridge traffic caused by the
          // read below. Resource timing is passive — unlike wrapping window.fetch,
          // it cannot perturb the page it is measuring.
          const t0 = performance.now()
          // Prove the fallback serves the real on-disk content. This exercises
          // the exact file-service read path openTextDocument uses: the overlay
          // tries the (now-empty) memfs first, then falls through to our disk
          // provider at priority -1.
          // IFileService.readFile resolves an IFileContent whose \`value\` is a
          // VSBuffer (not a Uint8Array), so decode through its own toString().
          const content = await fs.readFile(uri)
          const text = content.value.toString()
          // The load-bearing assertion: the bytes came over the \`/__fs/read\`
          // disk bridge just now. Without the fallback this count is 0 and the
          // readFile above throws FILE_NOT_FOUND instead.
          const diskReads = performance
            .getEntriesByType('resource')
            .filter((e) => e.startTime >= t0 && /__fs\\/read\\?/.test(e.name))
            .length
          // Put the mirror entry back (same bytes) so the workbench is not left
          // with a hole in its workspace — a missing entry keeps tsserver and the
          // Explorer churning and stalls the app's shutdown during teardown.
          try { await fs.writeFile(uri, content.value) } catch (e) {}
          return {
            opened: true,
            hasContent: /Page\\(|pageName/.test(text),
            existedBefore,
            diskReads,
            readLen: content.value.byteLength,
          }
        } catch (e) {
          return { opened: false, reason: String((e && e.message) || e) }
        }
      })()
    `

    const res = await runInWorkbench<{
      opened: boolean
      hasContent?: boolean
      existedBefore?: boolean
      diskReads?: number
      readLen?: number
      reason?: string
    }>(electronApp, OPEN_FALLBACK_EXPR).catch(() => ({ opened: false, reason: 'probe failed' }))

    expect(res.opened, `reading the memfs-missing file must fall back to disk; got=${JSON.stringify(res)}`).toBe(true)
    expect(
      res.hasContent,
      `the read must return the real on-disk source (Page(...)), not an error placeholder; got=${JSON.stringify(res)}`,
    ).toBe(true)
    expect(
      res.existedBefore,
      `the file must have been in the mirror before the test emptied it; got=${JSON.stringify(res)}`,
    ).toBe(true)
    expect(
      res.diskReads ?? 0,
      `the read must have gone over the /__fs/read disk bridge (proving the disk fallback served it, not the mirror or the watcher); got=${JSON.stringify(res)}`,
    ).toBeGreaterThan(0)
    expect(
      res.readLen ?? 0,
      `the disk fallback must have returned real file bytes; got=${JSON.stringify(res)}`,
    ).toBeGreaterThan(0)

    const notFound = await runInWorkbench<boolean>(electronApp, NOT_FOUND_VISIBLE_EXPR)
    expect(notFound, 'no "file was not found" placeholder should be visible for the disk-fallback read').toBe(false)
  })
})
