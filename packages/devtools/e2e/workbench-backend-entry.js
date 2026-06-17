// E2E entry that boots devtools through the v2 framework orchestration:
// `@dimina-kit/electron-deck`'s `electronDeck()` owns the process-lifecycle gate
// (whenReady) + wire/trust, and the devtools `RuntimeBackend` assembles the
// full runtime. Proves the framework+backend path boots the real devtools app
// end-to-end. Mirrors workbench-config-entry.js's off-screen handling.
import electron from 'electron'

import { electronDeck } from '@dimina-kit/electron-deck'
import { createDevtoolsBackend } from '../dist/main/runtime/devtools-backend.js'

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

// Fire-and-forget (do NOT top-level-await in an ESM main — electronDeck() awaits
// whenReady internally; the Electron event loop keeps the process alive).
electronDeck({ backend: createDevtoolsBackend({ appName: 'Downstream Backend Host' }) })
  .catch((err) => {
    console.error('[workbench-backend-entry] electronDeck() failed:', err)
  })
