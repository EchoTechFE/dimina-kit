/**
 * Single-context COI probe (one Electron process = one measurement) so a hang
 * or SIGTRAP in one context can never block the others.
 *
 * Env:
 *   COI_CTX  = 'A' top-level BrowserWindow | 'B' WebContentsView (default A)
 *   COI_COEP = 'require-corp' (default) | 'credentialless'
 *   COI_FLAG = '1' to --enable-features=SharedArrayBuffer
 * Prints one line: COI_PROBE_RESULT=<json>
 */
import { app, BrowserWindow, WebContentsView } from 'electron'
import http from 'node:http'

const CTX = process.env.COI_CTX || 'A'
const COEP = process.env.COI_COEP || 'require-corp'
const FLAG = process.env.COI_FLAG === '1'

if (FLAG) app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer')

// Hard watchdog: never hang the harness.
const watchdog = setTimeout(() => {
  console.log('COI_PROBE_RESULT=' + JSON.stringify({ ctx: CTX, coep: COEP, flag: FLAG, error: 'watchdog-timeout' }))
  app.exit(2)
}, 12000)

function startServer() {
  const server = http.createServer((req, res) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
    res.setHeader('Cross-Origin-Embedder-Policy', COEP)
    res.setHeader('Cross-Origin-Resource-Policy', COEP === 'credentialless' ? 'cross-origin' : 'same-origin')
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><meta charset=utf-8><title>coi</title><body>coi</body>')
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/` }))
  })
}

const settle = (ms) => new Promise((r) => setTimeout(r, ms))
const read = (wc) => wc.executeJavaScript(
  `({coi: self.crossOriginIsolated===true, sab: typeof SharedArrayBuffer!=='undefined'})`, true)

app.whenReady().then(async () => {
  const out = { ctx: CTX, coep: COEP, flag: FLAG }
  const { server, url } = await startServer()
  out.url = url
  try {
    if (CTX === 'A') {
      const w = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true } })
      w.setPosition(-6000, -6000)
      await w.loadURL(url)
      await settle(700)
      out.result = await read(w.webContents)
    } else {
      const host = new BrowserWindow({ show: false })
      host.setPosition(-6000, -6000)
      const v = new WebContentsView({ webPreferences: { contextIsolation: true } })
      host.contentView.addChildView(v)
      v.setBounds({ x: 0, y: 0, width: 800, height: 600 })
      await v.webContents.loadURL(url)
      await settle(700)
      out.result = await read(v.webContents)
    }
  } catch (e) {
    out.error = String(e)
  }
  server.close()
  clearTimeout(watchdog)
  console.log('COI_PROBE_RESULT=' + JSON.stringify(out))
  setTimeout(() => app.exit(0), 120)
})
