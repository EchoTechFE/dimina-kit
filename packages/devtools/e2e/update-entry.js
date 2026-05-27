// E2E entry for the update flow. Hits the real GitHub Releases API for
// EchoTechFE/dimina-kit and mocks the current version as '0' so the
// `release-YYYYMMDD-N` scheme always resolves to an available update.
import electron from 'electron'
import https from 'node:https'
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

// The runner may have a stale GITHUB_TOKEN in env (e.g. expired PAT). The
// updater silently treats 4xx as "no update", so a bad token would make the
// dialog never appear. Probe before using it; fall back to anonymous on 401/403.
async function validateGitHubToken(token) {
  if (!token) return undefined
  const ok = await new Promise((resolve) => {
    const req = https.request(
      'https://api.github.com/repos/EchoTechFE/dimina-kit',
      {
        method: 'HEAD',
        headers: {
          'User-Agent': 'dimina-kit-updater',
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
        },
      },
      (res) => { res.resume(); resolve(res.statusCode === 200) },
    )
    req.on('error', () => resolve(false))
    req.end()
  })
  return ok ? token : undefined
}

const token = await validateGitHubToken(process.env.GITHUB_TOKEN || undefined)

createWorkbenchApp({
  updateChecker: createGitHubReleaseChecker({
    owner: 'EchoTechFE',
    repo: 'dimina-kit',
    versionScheme: 'trailing-number',
    token,
  }),
  updateOptions: {
    initialDelay: 300,
    getCurrentVersion: () => '0',
  },
}).start()
