import fs from 'fs'
import os from 'os'
import path from 'path'
import { test, expect } from './fixtures'
import { ipcInvoke, closeProject, DEMO_APP_DIR } from './helpers'
import { ProjectChannel } from '../src/shared/ipc-channels'

interface OpenProjectResult {
  success: boolean
  port?: number
  appInfo?: { appId: string }
  error?: string
}

/**
 * Regression suite for the `container-api.js … q.initApp … JSON.parse
 * Unexpected token '<'` crash. The crash is produced when the container
 * fetch()-es a runtime asset (app-config.json, app-service.js, …) that
 * isn't on disk and the devkit dev server answers with `index.html`
 * via its SPA fallback — the HTML then flows into `JSON.parse()`.
 *
 * Two defences are covered:
 *  1. `project:open` must reject obviously broken directories *before*
 *     the simulator loads, so the user sees a friendly error instead of
 *     an unhandled rejection inside the webview.
 *  2. The devkit dev server must answer missing asset paths with a real
 *     404 (or at least non-HTML) so a stale in-flight fetch can't get
 *     fed HTML it can never parse.
 */

function makeScratchDir(label: string): string {
  const dir = path.join(
    os.tmpdir(),
    'dimina-kit-e2e',
    `${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  )
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

test.describe('openProject rejects broken projects gracefully', () => {
  test('non-existent directory → { success:false, error }', async ({ mainWindow }) => {
    const ghost = path.join(
      os.tmpdir(),
      'dimina-kit-e2e',
      `never-existed-${process.pid}-${Date.now()}`,
    )
    // Guarantee it doesn't exist.
    expect(fs.existsSync(ghost)).toBe(false)

    const result = await ipcInvoke<OpenProjectResult>(
      mainWindow,
      ProjectChannel.Open,
      ghost,
    )

    expect(result.success).toBe(false)
    expect(typeof result.error).toBe('string')
    expect(result.error && result.error.length).toBeGreaterThan(0)
    // Friendly Chinese message mentioning the missing directory / app.json.
    expect(result.error).toMatch(/(不存在|app\.json|目录)/)
  })

  test('directory without app.json → { success:false, error mentions app.json }', async ({ mainWindow }) => {
    const emptyDir = makeScratchDir('empty-project')
    try {
      const result = await ipcInvoke<OpenProjectResult>(
        mainWindow,
        ProjectChannel.Open,
        emptyDir,
      )

      expect(result.success).toBe(false)
      expect(typeof result.error).toBe('string')
      expect(result.error).toContain('app.json')
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true })
    }
  })

  test('directory whose project.config.json is malformed → graceful error', async ({ mainWindow }) => {
    const brokenDir = makeScratchDir('broken-config')
    // no app.json, and an unparseable project.config.json — the validator
    // used to explode on JSON.parse here; it should stay graceful.
    fs.writeFileSync(path.join(brokenDir, 'project.config.json'), '{not valid json')
    try {
      const result = await ipcInvoke<OpenProjectResult>(
        mainWindow,
        ProjectChannel.Open,
        brokenDir,
      )
      expect(result.success).toBe(false)
      expect(typeof result.error).toBe('string')
      expect(result.error && result.error.length).toBeGreaterThan(0)
    } finally {
      fs.rmSync(brokenDir, { recursive: true, force: true })
    }
  })
})

test.describe('devkit dev server does not serve HTML for missing asset paths', () => {
  test('missing *.json under an unknown appId returns non-HTML (ideally 404)', async ({ mainWindow }) => {
    const opened = await ipcInvoke<OpenProjectResult>(
      mainWindow,
      ProjectChannel.Open,
      DEMO_APP_DIR,
    )
    expect(opened.success).toBe(true)
    expect(typeof opened.port).toBe('number')
    const port = opened.port as number

    try {
      const url = `http://127.0.0.1:${port}/ghost-appid-${Date.now()}/main/app-config.json`
      const res = await fetch(url)
      const body = await res.text()

      // The real bug: server answers 200 with `<!doctype html>…`.
      // Either a real 404 or a non-HTML body is acceptable; HTML-with-200
      // is what breaks the container's JSON.parse.
      const looksLikeHtml = /^\s*<!doctype\s+html/i.test(body) || /^\s*<html/i.test(body)
      expect(
        looksLikeHtml && res.status === 200,
        `server returned HTML SPA fallback (status=${res.status}) for a JSON asset path; first 80 chars: ${JSON.stringify(body.slice(0, 80))}`,
      ).toBe(false)
    } finally {
      await closeProject(mainWindow)
    }
  })

  test('missing *.js asset also does not fall back to index.html', async ({ mainWindow }) => {
    const opened = await ipcInvoke<OpenProjectResult>(
      mainWindow,
      ProjectChannel.Open,
      DEMO_APP_DIR,
    )
    expect(opened.success).toBe(true)
    const port = opened.port as number

    try {
      const url = `http://127.0.0.1:${port}/ghost-appid-${Date.now()}/main/app-service.js`
      const res = await fetch(url)
      const body = await res.text()
      const looksLikeHtml = /^\s*<!doctype\s+html/i.test(body) || /^\s*<html/i.test(body)
      expect(looksLikeHtml && res.status === 200).toBe(false)
    } finally {
      await closeProject(mainWindow)
    }
  })
})
