// E2E entry for the update flow. Hits the real GitHub Releases API for
// EchoTechFE/dimina-kit and mocks the current version as '0' so the
// `release-YYYYMMDD-N` scheme always resolves to an available update.
import electron from 'electron'
import { createWorkbenchApp, createGitHubReleaseChecker } from '../dist/main/api.js'

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

createWorkbenchApp({
  updateChecker: createGitHubReleaseChecker({
    owner: 'EchoTechFE',
    repo: 'dimina-kit',
    versionScheme: 'trailing-number',
    token: process.env.GITHUB_TOKEN || undefined,
  }),
  updateOptions: {
    initialDelay: 300,
    getCurrentVersion: () => '0',
  },
}).start()
