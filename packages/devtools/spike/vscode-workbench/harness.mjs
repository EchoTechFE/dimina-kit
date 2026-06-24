/**
 * VS Code workbench harness — a standalone Electron main process (no full
 * devtools app) that:
 *   1. starts the COI http server over the built workbench bundle,
 *   2. mounts a WebContentsView in an offscreen window and loadURL()s the bundle,
 *   3. probes the death-line judgment criteria via executeJavaScript:
 *        - crossOriginIsolated === true   (CORE)
 *        - typeof SharedArrayBuffer       (CORE)
 *        - workbench/editor DOM rendered
 *        - extension-host worker alive (worker target count + a probe)
 *   4. screenshots to scratchpad, prints VSCODE_WORKBENCH_RESULT=<json>, exits.
 *
 * Modes:
 *   --mode=baseline  serve a trivial page (validates the http+COI plumbing only)
 *   --mode=workbench serve dist/ (the real workbench bundle)  [default]
 *
 * Offscreen + never focused (background-friendly).
 */
import { app, BrowserWindow, WebContentsView } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { startCoiServer } from './coi-server.mjs'

// Electron 41 does NOT grant crossOriginIsolated even with COOP/COEP over http
// (verified by coi-probe.mjs matrix). This switch enables SharedArrayBuffer
// itself without isolation — which is what VS Code's web stack actually checks.
if (process.env.WORKBENCH_NO_SAB_FLAG !== '1') {
  app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer')
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const MODE = (process.argv.find((a) => a.startsWith('--mode=')) || '--mode=workbench').split('=')[1]
const SHOT_DIR = process.env.SPIKE_SHOT_DIR || join(__dirname, 'shots')

const DIST_DIR = join(__dirname, 'dist')
const BASELINE_DIR = join(__dirname, 'baseline')
const FIXTURE_DIR = process.env.WORKBENCH_FIXTURE_DIR || join(__dirname, 'fixture-project')

function log(...a) { console.log('[workbench-harness]', ...a) }

async function settle(ms) { await new Promise((r) => setTimeout(r, ms)) }

async function shoot(view, name) {
  try {
    mkdirSync(SHOT_DIR, { recursive: true })
    const img = await view.webContents.capturePage()
    const p = join(SHOT_DIR, name + '.png')
    writeFileSync(p, img.toPNG())
    log('screenshot', p)
  } catch (e) {
    log('screenshot failed', String(e))
  }
}

async function probe(wc) {
  // Read isolation + DOM + worker evidence out of the loaded document.
  const dom = await wc.executeJavaScript(`(() => {
    const txt = (document.body && document.body.innerText || '').slice(0, 4000)
    return {
      crossOriginIsolated: self.crossOriginIsolated === true,
      sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
      title: document.title,
      bodyLen: (document.body && document.body.innerHTML || '').length,
      // VS Code workbench DOM landmarks (best-effort, present once workbench mounts)
      hasMonaco: !!document.querySelector('.monaco-editor'),
      hasWorkbench: !!document.querySelector('.monaco-workbench'),
      hasActivityBar: !!document.querySelector('.activitybar'),
      hasEditorPart: !!document.querySelector('.part.editor'),
      // spike-injected status (workbench page sets window.__WB_STATUS)
      wbStatus: (typeof window.__WB_STATUS !== 'undefined') ? window.__WB_STATUS : null,
      wbError: (typeof window.__WB_ERROR !== 'undefined') ? String(window.__WB_ERROR) : null,
      wbExtHost: (typeof window.__WB_EXTHOST !== 'undefined') ? window.__WB_EXTHOST : null,
      wbWxml: (typeof window.__WB_WXML !== 'undefined') ? window.__WB_WXML : null,
      wbDts: (typeof window.__WB_DTS !== 'undefined') ? window.__WB_DTS : null,
      // Explorer tree landmarks: row labels for known fixture files.
      explorerLabels: Array.from(document.querySelectorAll('.monaco-list-row .label-name, .explorer-item .label-name'))
        .map((el) => (el.textContent || '').trim()).filter(Boolean).slice(0, 60),
      bodyText: txt,
    }
  })()`, true)
  return dom
}

async function run() {
  const root = MODE === 'baseline' ? BASELINE_DIR : DIST_DIR
  if (MODE === 'baseline') {
    mkdirSync(BASELINE_DIR, { recursive: true })
    writeFileSync(join(BASELINE_DIR, 'index.html'),
      `<!doctype html><html><head><meta charset="utf-8"><title>coi-baseline</title></head>
       <body><h1>COI baseline</h1>
       <script type="module">
         window.__WB_STATUS = 'baseline-loaded'
         // spawn a same-origin module worker to prove COEP require-corp allows it
         try {
           const blobUrl = URL.createObjectURL(new Blob(
             ['self.postMessage({sab: typeof SharedArrayBuffer, coi: self.crossOriginIsolated})'],
             {type:'text/javascript'}))
           const w = new Worker(blobUrl, {type:'module'})
           w.onmessage = (e) => { window.__WB_WORKER = e.data }
         } catch (e) { window.__WB_ERROR = String(e) }
       </script></body></html>`)
  }

  if (!existsSync(root) || !existsSync(join(root, 'index.html'))) {
    return { ok: false, mode: MODE, error: 'missing bundle: ' + join(root, 'index.html') + ' — run the build first' }
  }

  const server = await startCoiServer(root, MODE === 'baseline' ? {} : { fsRoot: FIXTURE_DIR })
  log('serving', root, 'at', server.baseUrl, MODE === 'baseline' ? '' : '(fsRoot=' + FIXTURE_DIR + ')')

  const win = new BrowserWindow({
    width: 1280, height: 860, show: false,
    webPreferences: { offscreen: false },
  })
  win.setPosition(-5000, -5000)

  const view = new WebContentsView({
    webPreferences: { contextIsolation: true, sandbox: false },
  })
  win.contentView.addChildView(view)
  view.setBounds({ x: 0, y: 0, width: 1280, height: 860 })

  const wc = view.webContents
  const consoleLines = []
  wc.on('console-message', (_e, level, message) => {
    consoleLines.push({ level, message: String(message).slice(0, 500) })
  })
  let crashed = null
  wc.on('render-process-gone', (_e, details) => { crashed = details })

  await wc.loadURL(server.baseUrl)
  log('loaded; settling for workbench init...')

  // Workbench init is async (initialize() + worker spawn + extension activation).
  // Poll wbStatus / DOM until it stabilizes, up to a cap.
  let last = null
  const maxWaitMs = MODE === 'baseline' ? 3000 : 30000
  const start = Date.now()
  while (Date.now() - start < maxWaitMs) {
    await settle(1000)
    try { last = await probe(wc) } catch (e) { last = { probeError: String(e) } }
    if (MODE === 'baseline' && last.crossOriginIsolated) break
    if (MODE !== 'baseline' && (/^exthost-/.test(last.wbStatus || '') || last.wbError)) {
      break
    }
    if (MODE !== 'baseline' && (last.hasWorkbench || last.hasMonaco) && Date.now() - start > 18000) {
      // workbench up but ext-host probe never resolved a status — stop waiting
      break
    }
  }

  // Worker targets via CDP debugger (extension host runs as a worker).
  let workerTargets = []
  try {
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3')
    await wc.debugger.sendCommand('Target.setDiscoverTargets', { discover: true })
    await settle(500)
    const { targetInfos } = await wc.debugger.sendCommand('Target.getTargets')
    workerTargets = targetInfos
      .filter((t) => t.type === 'worker' || t.type === 'shared_worker' || t.type === 'service_worker' || t.type === 'iframe')
      .map((t) => ({ type: t.type, url: String(t.url).slice(0, 200), title: t.title }))
  } catch (e) {
    workerTargets = [{ error: String(e) }]
  }

  // Decisive ext-host viability test: spawn a same-origin module Worker in the
  // page and confirm it runs + can see SharedArrayBuffer. A web ext-host is
  // exactly this (module worker, same origin). Proves COEP doesn't block it.
  let moduleWorkerProbe = null
  try {
    moduleWorkerProbe = await wc.executeJavaScript(`(async () => {
      try {
        const src = 'self.postMessage({ran:true, sab: typeof SharedArrayBuffer!=="undefined", coi: self.crossOriginIsolated===true})'
        const url = URL.createObjectURL(new Blob([src], {type:'text/javascript'}))
        const w = new Worker(url, {type:'module'})
        const data = await new Promise((res, rej) => {
          const t = setTimeout(() => rej(new Error('worker-timeout')), 2500)
          w.onmessage = (e) => { clearTimeout(t); res(e.data) }
          w.onerror = (e) => { clearTimeout(t); rej(new Error('worker-error: ' + (e.message||e))) }
        })
        w.terminate()
        return data
      } catch (e) { return { error: String(e) } }
    })()`, true)
  } catch (e) {
    moduleWorkerProbe = { error: String(e) }
  }

  await shoot(view, MODE + '-final')

  const result = {
    ok: false,
    mode: MODE,
    baseUrl: server.baseUrl,
    crossOriginIsolated: last?.crossOriginIsolated ?? false,
    sharedArrayBuffer: last?.sharedArrayBuffer ?? false,
    rendered: !!(last?.hasWorkbench || last?.hasMonaco),
    domLandmarks: {
      monaco: last?.hasMonaco, workbench: last?.hasWorkbench,
      activityBar: last?.hasActivityBar, editorPart: last?.hasEditorPart,
    },
    wbStatus: last?.wbStatus ?? null,
    wbError: last?.wbError ?? null,
    wbExtHost: last?.wbExtHost ?? null,
    wbWxml: last?.wbWxml ?? null,
    wbDts: last?.wbDts ?? null,
    explorerLabels: last?.explorerLabels ?? [],
    title: last?.title,
    bodyLen: last?.bodyLen,
    bodyTextSample: (last?.bodyText || '').slice(0, 600),
    workerTargets,
    extHostAlive: last?.wbStatus === 'exthost-alive' && last?.wbExtHost?.ping === 'pong-from-exthost',
    extHostWorker: workerTargets.some((t) => /extensionHost|extHost|webWorkerExtensionHost/i.test(t.url || '')),
    anyWorker: workerTargets.some((t) => t.type === 'worker'),
    moduleWorkerProbe,
    crashed,
    consoleErrors: consoleLines.filter((c) => c.level === 2 || c.level === 3).slice(0, 40),
    consoleSample: consoleLines.slice(0, 20),
  }

  if (MODE === 'baseline') {
    result.ok = result.crossOriginIsolated && result.sharedArrayBuffer
  } else {
    // Death-line for the language-intelligence route: SAB available (via flag),
    // workbench rendered, AND the web ext-host actually activated.
    result.ok = result.sharedArrayBuffer && result.rendered && result.extHostAlive
  }

  await server.close().catch(() => {})
  return result
}

app.whenReady().then(async () => {
  let result
  try {
    result = await run()
  } catch (e) {
    result = { ok: false, mode: MODE, fatal: String(e && e.stack ? e.stack : e) }
  }
  console.log('VSCODE_WORKBENCH_RESULT=' + JSON.stringify(result))
  setTimeout(() => app.exit(result.ok ? 0 : 1), 100)
})
