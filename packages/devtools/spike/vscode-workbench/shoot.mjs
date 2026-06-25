/**
 * Screenshot-only run: load the built VS Code workbench in a WCV inside a real
 * (but offscreen, never-focused) window and capturePage to scratchpad. The
 * window must be shown for the compositor to produce frames (capturePage on a
 * hidden/offscreen-rendered WCV yields UnknownVizError).
 */
import { app, BrowserWindow, WebContentsView } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { writeFileSync, mkdirSync } from 'node:fs'
import { startCoiServer } from './coi-server.mjs'

app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer')

const __dirname = dirname(fileURLToPath(import.meta.url))
const SHOT_DIR = process.env.SPIKE_SHOT_DIR || join(__dirname, 'shots')
const settle = (ms) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  const server = await startCoiServer(join(__dirname, 'dist'))
  const win = new BrowserWindow({ width: 1280, height: 820, show: true, x: -4000, y: -4000 })
  win.setPosition(-4000, -4000)
  const view = new WebContentsView({ webPreferences: { contextIsolation: true } })
  win.contentView.addChildView(view)
  view.setBounds({ x: 0, y: 0, width: 1280, height: 820 })
  await view.webContents.loadURL(server.baseUrl)
  await settle(9000)
  try {
    mkdirSync(SHOT_DIR, { recursive: true })
    const img = await view.webContents.capturePage()
    const p = join(SHOT_DIR, 'workbench.png')
    writeFileSync(p, img.toPNG())
    console.log('SHOT_OK=' + p + ' bytes=' + img.toPNG().length)
  } catch (e) {
    console.log('SHOT_FAIL=' + String(e))
  }
  await server.close().catch(() => {})
  setTimeout(() => app.exit(0), 150)
})
