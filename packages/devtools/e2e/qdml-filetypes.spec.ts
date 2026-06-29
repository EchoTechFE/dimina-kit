/**
 * Custom file types (`.qdml`/`.qdss`/`.qds`) end-to-end against a real devtools
 * runtime configured with `WorkbenchAppConfig.fileTypes`.
 *
 * Two contracts, one launch:
 *  - Compilation: a page authored in `.qdml` + `.qdss` compiles (template→wxml,
 *    style→css) and renders. Proven by reading the render guest DOM: the marker
 *    text appears and the `.qdss` color rule is applied.
 *  - Editor: the embedded VS Code workbench classifies the custom extensions by
 *    languageId (qdml→wxml / qdss→css / qds→javascript) and the wxml language
 *    service answers a completion on the `.qdml` buffer — the same languageId
 *    that drives TextMate highlighting drives the LSP providers.
 *
 * Uses its own launch entry (qdml-verify-entry.js) because the shared fixture
 * boots the stock app with no fileTypes; this one passes the fileTypes config.
 */
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { _electron, test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { openProjectInUI, pollUntil, ipcInvoke } from './helpers'
import { ViewChannel } from '../src/shared/ipc-channels'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.resolve(__dirname, 'fixtures', 'qdml-app')

const dataBase = (process.env.DIMINA_DEVTOOLS_DATA_DIR
  ?? (fs.existsSync('/Volumes/jdisk') ? '/Volumes/jdisk/electron-data/dimina-devtools-e2e' : null))
  ?? path.resolve(__dirname, '..', 'node_modules', '.cache', 'devtools-e2e')

/** Concatenated visible text of every render-host page guest (pageFrame.html). */
async function readRenderText(app: ElectronApplication): Promise<string> {
  try {
    return await app.evaluate(async ({ webContents }) => {
      const frames = webContents.getAllWebContents()
        .filter((wc) => !wc.isDestroyed() && wc.getURL().includes('pageFrame.html'))
      const out: string[] = []
      for (const f of frames) {
        try { out.push((await f.executeJavaScript('document.body.innerText')) as string) } catch {}
      }
      return out.join('\n---\n')
    })
  } catch { return '' }
}

/** Computed style of the element whose text is exactly `marker`, read in the render guest. */
async function readStyledMarker(app: ElectronApplication, marker: string): Promise<{ found: boolean; color?: string; fontWeight?: string }> {
  return app.evaluate(async ({ webContents }, m) => {
    const frames = webContents.getAllWebContents()
      .filter((wc) => !wc.isDestroyed() && wc.getURL().includes('pageFrame.html'))
    for (const f of frames) {
      try {
        const r = await f.executeJavaScript(`(() => {
          const all = Array.from(document.querySelectorAll('*'));
          const el = all.find(e => e.children.length === 0 && (e.textContent||'').trim() === ${JSON.stringify(m)});
          if (!el) return { found: false };
          const c = getComputedStyle(el);
          return { found: true, color: c.color, fontWeight: c.fontWeight };
        })()`) as { found: boolean; color?: string; fontWeight?: string }
        if (r && r.found) return r
      } catch {}
    }
    return { found: false }
  }, marker)
}

/** Probe the workbench WCV: classify the custom files + run a wxml completion. */
async function probeEditor(app: ElectronApplication): Promise<{
  status: string | null
  qdml?: string; qdss?: string; qds?: string; tagSample?: string[]
}> {
  return app.evaluate(async ({ webContents }) => {
    const wcs = webContents.getAllWebContents().filter((wc) => !wc.isDestroyed())
    let target: import('electron').WebContents | undefined
    let status: string | null = null
    for (const wc of wcs) {
      try {
        const s = await wc.executeJavaScript('typeof window.__WB_STATUS === "string" ? window.__WB_STATUS : null')
        if (typeof s === 'string') { target = wc; status = s; break }
      } catch {}
    }
    if (!target) return { status: null }
    const result = await target.executeJavaScript(`(async () => {
      const p = window.__WB_PROBE;
      if (!p) return { status: window.__WB_STATUS, noProbe: true };
      const vscode = p.vscode, URI = p.URI;
      const open = async (rel) => {
        try {
          const doc = await vscode.workspace.openTextDocument(URI.parse('file:///workspace/' + rel));
          return doc.languageId;
        } catch (e) { return 'ERR:' + String(e); }
      };
      const qdml = await open('pages/index/index.qdml');
      const qdss = await open('pages/index/index.qdss');
      const qds  = await open('pages/index/util.qds');
      let tagSample = [];
      try {
        const uri = URI.parse('file:///workspace/pages/index/index.qdml');
        const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', uri, new vscode.Position(0, 1));
        const items = (list && list.items) || [];
        tagSample = items.map(i => typeof i.label === 'string' ? i.label : (i.label && i.label.label)).filter(Boolean).slice(0, 60);
      } catch (e) { tagSample = ['ERR:' + String(e)]; }
      return { status: window.__WB_STATUS, qdml, qdss, qds, tagSample };
    })()`) as { status: string; qdml?: string; qdss?: string; qds?: string; tagSample?: string[] }
    return { status: result.status ?? status, ...result }
  })
}

test.describe('Custom file types (.qdml/.qdss/.qds) — render + editor', () => {
  test.setTimeout(180_000)
  let app: ElectronApplication
  let mainWindow: Page

  test.beforeAll(async () => {
    // Launch + addProject + first compile easily exceeds Playwright's default
    // 60s hook budget; raise the hook timeout (the describe-level setTimeout
    // only governs test bodies, not hooks).
    test.setTimeout(150_000)
    const userDataDir = path.join(dataBase, 'userdata', 'qdml-filetypes')
    fs.mkdirSync(userDataDir, { recursive: true })
    app = await _electron.launch({
      args: [path.resolve(__dirname, 'qdml-verify-entry.js'), `--user-data-dir=${userDataDir}`],
      env: { ...process.env, NODE_ENV: 'test' },
    })
    mainWindow = await app.firstWindow()
    await mainWindow.waitForLoadState('domcontentloaded')
    await app.evaluate(async ({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]
      if (w) { w.setPosition(-2000, -2000); w.blur() }
    })
    await openProjectInUI(mainWindow, FIXTURE, { waitMs: 60_000 })
  })

  test.afterAll(async () => { await app?.close() })

  test('compilation: .qdml renders and .qdss styling is applied', async () => {
    const text = await pollUntil(() => readRenderText(app), (t) => t.includes('QDML_RENDER_OK'), 60_000, 1000)
    expect(text, 'render guest should show the .qdml marker').toContain('QDML_RENDER_OK')
    expect(text, 'second .qdml view should render too').toContain('QDSS_STYLED')

    const styled = await pollUntil(
      () => readStyledMarker(app, 'QDSS_STYLED'),
      (r) => r.found && r.color === 'rgb(200, 30, 40)',
      30_000, 1000,
    )
    expect(styled.found, 'the QDSS_STYLED element must exist in the render DOM').toBe(true)
    expect(styled.color, '.qdss color rule must be compiled+applied').toBe('rgb(200, 30, 40)')
  })

  test('editor: workbench classifies .qdml/.qdss/.qds and wxml LSP answers on .qdml', async () => {
    // Force the lazily-attached workbench WCV to load by feeding the editor dock
    // slot a non-zero rect (the renderer's ViewAnchor would do this when the
    // panel is visible; in this off-screen harness we drive the IPC directly).
    await ipcInvoke(mainWindow, ViewChannel.WorkbenchBounds, { x: 0, y: 0, width: 900, height: 700 }).catch(() => {})

    const probe = await pollUntil(
      () => probeEditor(app),
      (r) => !!r.status && (r.status === 'workbench-ready' || r.status === 'exthost-alive') && typeof r.qdml === 'string',
      90_000, 1500,
    )

    expect(probe.status, 'workbench must reach a ready status').toMatch(/workbench-ready|exthost-alive/)
    expect(probe.qdml, '.qdml must classify as wxml (drives highlighting + wxml LSP)').toBe('wxml')
    expect(probe.qdss, '.qdss must classify as css').toBe('css')
    expect(probe.qds, '.qds must classify as javascript').toBe('javascript')

    const tags = probe.tagSample ?? []
    expect(
      tags.includes('view') || tags.includes('scroll-view'),
      `wxml completion must answer on the .qdml buffer (LSP via languageId); got=${JSON.stringify(tags)}`,
    ).toBe(true)
  })
})
