import { app } from 'electron'
import { launch } from './app/launch.js'
import { createGitHubReleaseChecker } from './services/update/index.js'

// Only the packaged standalone app self-updates against this repo's GitHub
// Releases; `pnpm dev` runs stay quiet (no API calls, no update dialog) —
// same app.isPackaged gate used elsewhere for dev-only behavior. Hosts that
// embed devtools via `launch(config)` supply their own `updateChecker` (or
// none) and are unaffected — this default only applies to this entry point.
// release.yml tags releases `release-YYYYMMDD-N`, hence trailing-number.
const updateChecker = app.isPackaged
  ? createGitHubReleaseChecker({ owner: 'EchoTechFE', repo: 'dimina-kit', versionScheme: 'trailing-number' })
  : undefined

// Fire-and-forget boot: launch() returns the electron-deck whenReady gate
// promise. A bare call would let a boot failure escape as an unhandledRejection
// (no diagnostics, can be swallowed). Surface it via a structured failure exit:
// log the cause and exit non-zero (per workbench-model.md fire-and-forget rule).
launch({ updateChecker }).catch((err: unknown) => {
  console.error('[devtools] fatal: launch() failed during boot', err)
  app.exit(1)
})
