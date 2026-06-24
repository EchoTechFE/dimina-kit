/**
 * Deep I4/I5 probe: loads the A2 workbench over the COI server with the fixture
 * project as fsRoot, then drives the page-side vscode API to verify:
 *   I4: workspace folder opened (diminafs:/), readdir lists fixture files,
 *       open + edit + save round-trips through diminafs onto disk.
 *   I5: wxml completion returns component tags; hover returns docs;
 *       JS dd./wx. completion surfaces the dimina API.
 * Screenshots the explorer + an open .wxml for visual evidence.
 */
import { app, BrowserWindow, WebContentsView } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { writeFileSync, mkdirSync, readFileSync, rmSync, copyFileSync } from 'node:fs'
import { startCoiServer } from './coi-server.mjs'

app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer')

const __dirname = dirname(fileURLToPath(import.meta.url))
const SHOT_DIR = process.env.SPIKE_SHOT_DIR || join(__dirname, 'shots')
const FIXTURE_DIR = join(__dirname, 'fixture-project')
const settle = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log('[i4i5]', ...a)

async function shoot(view, name) {
  try {
    mkdirSync(SHOT_DIR, { recursive: true })
    const img = await view.webContents.capturePage()
    writeFileSync(join(SHOT_DIR, name + '.png'), img.toPNG())
    log('shot', name)
  } catch (e) { log('shot failed', String(e)) }
}

app.whenReady().then(async () => {
  // Hard watchdog: never let the probe hang the run.
  const watchdog = setTimeout(() => {
    console.log('I4I5_RESULT=' + JSON.stringify({ watchdogTimeout: true }))
    app.exit(2)
  }, 200000)
  const out = { i4: {}, i5: {} }
  const server = await startCoiServer(join(__dirname, 'dist'), { fsRoot: FIXTURE_DIR })
  const win = new BrowserWindow({ width: 1400, height: 900, show: true, x: -5000, y: -5000 })
  win.setPosition(-5000, -5000)
  const view = new WebContentsView({ webPreferences: { contextIsolation: true, sandbox: false } })
  win.contentView.addChildView(view)
  view.setBounds({ x: 0, y: 0, width: 1400, height: 900 })
  const wc = view.webContents
  wc.on('console-message', (_e, level, msg) => { if (level >= 2) log('page-console', String(msg).slice(0, 200)) })

  // Back up the wxml the probe mutates so we can restore the fixture after.
  const wxmlPath = join(FIXTURE_DIR, 'pages/index.wxml')
  const wxmlBackup = readFileSync(wxmlPath, 'utf8')

  await wc.loadURL(server.baseUrl)
  log('loaded; waiting for exthost-alive...')
  for (let i = 0; i < 30; i++) {
    await settle(1000)
    const st = await wc.executeJavaScript('window.__A2_STATUS')
    if (st === 'exthost-alive' || /error/.test(String(st))) { log('status', st); break }
  }
  // Give the workspace + TS service a moment to finish.
  await settle(4000)

  // ---- I4: workspace folder + readdir + edit/save round-trip ----
  out.i4 = await wc.executeJavaScript(`(async () => {
    const r = {}
    try {
      const P = window.__A2_PROBE
      if (!P) return { error: 'no __A2_PROBE' }
      const ws = await P.getService(P.IWorkspaceContextService)
      r.folders = ws.getWorkspace().folders.map(f => f.uri.toString())
      const fs = await P.getService(P.IFileService)
      const rootStat = await fs.resolve(P.URI.parse('file:///workspace'))
      r.rootChildren = (rootStat.children || []).map(c => c.name).slice(0, 40)
      const wxmlUri = P.URI.parse('file:///workspace/pages/index.wxml')
      const content = await fs.readFile(wxmlUri)
      r.wxmlHead = content.value.toString().slice(0, 120)
      // edit + save round-trip: append a marker, write (memfs), confirm the
      // save-flush listener pushed it back to disk (verified disk-side later).
      const marker = '<!-- a2-roundtrip ' + Date.now() + ' -->'
      const newText = content.value.toString() + '\\n' + marker
      await fs.writeFile(wxmlUri, P.VSBuffer.fromString(newText))
      const reread = await fs.readFile(wxmlUri)
      r.roundtripOk = reread.value.toString().includes(marker)
      r.roundtripMarker = marker
      await new Promise(res => setTimeout(res, 800)) // let the flush land on disk
    } catch (e) { r.error = String(e && e.stack || e) }
    return r
  })()`, true)
  log('I4', JSON.stringify(out.i4).slice(0, 600))

  // ---- I5: open .wxml + .js, drive completion + hover via vscode API ----
  out.i5 = await wc.executeJavaScript(`(async () => {
    const r = {}
    const P = window.__A2_PROBE
    if (!P) return { error: 'no __A2_PROBE' }
    const vscode = P.vscode
    const sleep = ms => new Promise(res => setTimeout(res, ms))
    // Never let a stalled provider hang the whole probe.
    const withDeadline = (p, ms, fallback) => Promise.race([p, new Promise(res => setTimeout(() => res(fallback), ms))])
    r.wxmlStatus = window.__A2_WXML
    r.dtsStatus = window.__A2_DTS
    try {
      const ls = await P.getService(P.ILanguageService)
      r.wxmlRegistered = ls.isRegisteredLanguageId('wxml')
    } catch (e) { r.langErr = String(e) }

    // ----- wxml completion + hover -----
    try {
      const wxmlUri = vscode.Uri.parse('file:///workspace/pages/index.wxml')
      const doc = await vscode.workspace.openTextDocument(wxmlUri)
      await vscode.window.showTextDocument(doc)
      r.wxmlLanguageId = doc.languageId
      await sleep(800)
      // completion right after a '<' at end of file → tag suggestions
      const probeText = doc.getText() + '\\n<'
      // write the probe variant so the position has a '<' to complete from
      const fs = await P.getService(P.IFileService)
      await fs.writeFile(wxmlUri, P.VSBuffer.fromString(probeText))
      const doc2 = await vscode.workspace.openTextDocument(wxmlUri)
      const lastLine = doc2.lineCount - 1
      const pos = new vscode.Position(lastLine, 1) // just after '<'
      const comp = await withDeadline(vscode.commands.executeCommand('vscode.executeCompletionItemProvider', wxmlUri, pos), 8000, { items: [] })
      const labels = (comp && comp.items ? comp.items : []).map(i => typeof i.label === 'string' ? i.label : (i.label && i.label.label)).filter(Boolean)
      r.wxmlCompletionCount = labels.length
      r.wxmlCompletionSample = labels.slice(0, 25)
      r.wxmlHasViewTag = labels.includes('view')
      r.wxmlHasScrollView = labels.includes('scroll-view')
      // hover over the first '<view' occurrence in the original text
      const text = doc2.getText()
      const idx = text.indexOf('<view')
      if (idx >= 0) {
        const before = text.slice(0, idx + 2) // inside the tag name
        const line = (before.match(/\\n/g) || []).length
        const lastNl = before.lastIndexOf('\\n')
        const ch = before.length - (lastNl + 1)
        const hovers = await withDeadline(vscode.commands.executeCommand('vscode.executeHoverProvider', wxmlUri, new vscode.Position(line, ch)), 8000, [])
        const hv = (hovers || []).flatMap(h => (h.contents || []).map(c => typeof c === 'string' ? c : (c.value || '')))
        r.wxmlHoverSample = hv.join(' | ').slice(0, 200)
      }
    } catch (e) { r.wxmlErr = String(e && e.stack || e) }

    // ----- JS dd./wx. completion (under file:///workspace so tsserver loads
    //        jsconfig + the ambient dimina.d.ts) -----
    try {
      const fs = await P.getService(P.IFileService)
      const jsUri = vscode.Uri.parse('file:///workspace/__probe_dd.js')
      await fs.writeFile(jsUri, P.VSBuffer.fromString('dd.'))
      const jsDoc = await vscode.workspace.openTextDocument(jsUri)
      await vscode.window.showTextDocument(jsDoc)
      r.jsLanguageId = jsDoc.languageId
      // The TS server in the worker needs time to index the project + the
      // ambient dimina.d.ts. Poll until member completions arrive (dd. yields
      // miniProgram/getLocation/openLocation) or give up.
      const ddPos = new vscode.Position(0, 3) // after 'dd.'
      let labels = []
      for (let attempt = 0; attempt < 12; attempt++) {
        await sleep(2000)
        const comp = await withDeadline(
          vscode.commands.executeCommand('vscode.executeCompletionItemProvider', jsUri, ddPos, '.'),
          8000,
          { items: [] },
        )
        labels = (comp && comp.items ? comp.items : [])
          .map(i => typeof i.label === 'string' ? i.label : (i.label && i.label.label))
          .filter(Boolean)
        r.ddAttempts = attempt + 1
        if (labels.includes('miniProgram') || labels.includes('getLocation')) break
      }
      r.ddCompletionCount = labels.length
      r.ddCompletionSample = labels.slice(0, 25)
      r.ddHasMiniProgram = labels.includes('miniProgram')
      r.ddHasGetLocation = labels.includes('getLocation')
      r.ddHasOpenLocation = labels.includes('openLocation')
      // Hover on the 'dd' identifier — type must NOT be 'any' (proves the
      // ambient d.ts is in the program, not a fallback global).
      const ddHov = await withDeadline(vscode.commands.executeCommand('vscode.executeHoverProvider', jsUri, new vscode.Position(0, 1)), 8000, [])
      r.ddHover = (ddHov || []).flatMap(h => (h.contents || []).map(c => typeof c === 'string' ? c : (c.value || ''))).join(' | ').slice(0, 200)
      r.ddTypeResolved = /Dimina\\.DD|DD\b/.test(r.ddHover) && !/\\bany\\b/.test(r.ddHover)
    } catch (e) { r.ddErr = String(e && e.stack || e) }

    // ----- wx. completion (alias of dd) -----
    try {
      const fs = await P.getService(P.IFileService)
      const wxUri = vscode.Uri.parse('file:///workspace/__probe_wx.js')
      await fs.writeFile(wxUri, P.VSBuffer.fromString('wx.'))
      const wxDoc = await vscode.workspace.openTextDocument(wxUri)
      await vscode.window.showTextDocument(wxDoc)
      let wxLabels = []
      for (let attempt = 0; attempt < 6; attempt++) {
        await sleep(2000)
        const comp = await withDeadline(vscode.commands.executeCommand('vscode.executeCompletionItemProvider', wxUri, new vscode.Position(0, 3), '.'), 8000, { items: [] })
        wxLabels = (comp && comp.items ? comp.items : []).map(i => typeof i.label === 'string' ? i.label : (i.label && i.label.label)).filter(Boolean)
        if (wxLabels.includes('miniProgram') || wxLabels.includes('getLocation')) break
      }
      r.wxHasMiniProgram = wxLabels.includes('miniProgram')
      r.wxHasGetLocation = wxLabels.includes('getLocation')
      r.wxSample = wxLabels.slice(0, 15)
    } catch (e) { r.wxErr = String(e && e.stack || e) }
    return r
  })()`, true)
  log('I5', JSON.stringify(out.i5).slice(0, 800))

  // reveal Explorer
  await wc.executeJavaScript(`(async () => { try { const P=window.__A2_PROBE; const cmd=await P.getService(P.ICommandService); await cmd.executeCommand('workbench.view.explorer') } catch(e){} })()`, true)
  await settle(2000)
  out.explorerLabels = await wc.executeJavaScript(`Array.from(document.querySelectorAll('.explorer-folders-view .monaco-list-row .label-name, .monaco-list-row .monaco-highlighted-label')).map(e=>(e.textContent||'').trim()).filter(Boolean).slice(0,60)`, true)
  log('explorerLabels', JSON.stringify(out.explorerLabels))

  await shoot(view, 'i4i5-workbench')

  // Verify the on-disk file actually got the round-trip marker.
  try {
    const disk = readFileSync(join(FIXTURE_DIR, 'pages/index.wxml'), 'utf8')
    out.diskHasMarker = out.i4.roundtripMarker ? disk.includes(out.i4.roundtripMarker) : null
  } catch (e) { out.diskReadError = String(e) }

  clearTimeout(watchdog)
  console.log('I4I5_RESULT=' + JSON.stringify(out))
  await server.close().catch(() => {})
  // Restore the fixture wxml + drop the probe scratch file.
  try { writeFileSync(wxmlPath, wxmlBackup) } catch {}
  try { rmSync(join(FIXTURE_DIR, '__probe_dd.js'), { force: true }) } catch {}
  try { rmSync(join(FIXTURE_DIR, '__probe_wx.js'), { force: true }) } catch {}
  setTimeout(() => app.exit(0), 150)
})
