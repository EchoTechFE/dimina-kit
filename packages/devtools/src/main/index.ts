import { app } from 'electron'
import { launch } from './app/launch.js'

// Fire-and-forget boot: launch() returns the electron-deck whenReady gate
// promise. A bare call would let a boot failure escape as an unhandledRejection
// (no diagnostics, can be swallowed). Surface it via a structured failure exit:
// log the cause and exit non-zero (per workbench-model.md fire-and-forget rule).
launch().catch((err: unknown) => {
  console.error('[devtools] fatal: launch() failed during boot', err)
  app.exit(1)
})
