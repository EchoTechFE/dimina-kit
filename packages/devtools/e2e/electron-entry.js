// E2E test entry point — instantiates the v1 app with a stub adapter
import { createWorkbenchApp } from '../dist/main/api.js'
import electron from 'electron'

// In test mode, prevent any BrowserWindow from stealing user focus by moving
// it off-screen and blurring immediately after it becomes ready to show.
if (process.env.NODE_ENV === 'test') {
  const moveOffscreen = (win) => {
    try {
      win.setPosition(-2000, -2000)
      if (typeof win.blur === 'function') win.blur()
    } catch {}
  }
  electron.app.on('browser-window-created', (_e, win) => {
    try {
      win.once('ready-to-show', () => moveOffscreen(win))
      win.on('show', () => moveOffscreen(win))
      win.on('focus', () => {
        try { win.blur() } catch {}
      })
    } catch {}
  })
}

// Real compilation adapter backed by dimina-devkit — required for specs that
// open demo-app and exercise the simulator / automator / devtools panels.
import path from 'node:path'
import { simulatorDir } from '../dist/main/api.js'

const e2eAdapter = {
  async openProject(opts) {
    const { openProject } = await import('@dimina-kit/devkit')
    return openProject({
      ...opts,
      sourcemap: !electron.app.isPackaged,
      simulatorDir,
      outputDir: path.join(electron.app.getPath('userData'), 'dimina-fe-output'),
    })
  },
}

const app = createWorkbenchApp({ adapter: e2eAdapter })
void app.start()
