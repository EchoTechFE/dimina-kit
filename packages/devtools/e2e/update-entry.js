// E2E entry for the update flow. Bypasses the default launcher so we can
// wire a synthetic UpdateChecker (no network) with getCurrentVersion='0'.
import electron from 'electron'
import fs from 'fs'
import path from 'path'
import { createWorkbenchApp } from '../dist/main/api.js'

if (process.env.NODE_ENV === 'test') {
  const hide = (win) => {
    try {
      win.setPosition(-2000, -2000)
      if (typeof win.blur === 'function') win.blur()
    } catch {}
  }
  electron.app.on('browser-window-created', (_e, win) => {
    try {
      win.once('ready-to-show', () => hide(win))
      win.on('show', () => hide(win))
    } catch {}
  })
}

const syntheticChecker = {
  async checkForUpdates() {
    return {
      version: '9.9.9',
      downloadUrl: 'synthetic://update',
      releaseNotes: 'Synthetic release notes used by the e2e update flow.',
    }
  },
  async downloadUpdate(_info, onProgress) {
    for (const pct of [0, 25, 50, 75, 100]) {
      onProgress?.(pct)
      await new Promise((r) => setTimeout(r, 40))
    }
    const filePath = path.join(electron.app.getPath('temp'), 'dimina-update-e2e.bin')
    fs.writeFileSync(filePath, Buffer.from('synthetic update payload'))
    return filePath
  },
}

createWorkbenchApp({
  updateChecker: syntheticChecker,
  updateOptions: {
    initialDelay: 300,
    getCurrentVersion: () => '0',
  },
}).start()
