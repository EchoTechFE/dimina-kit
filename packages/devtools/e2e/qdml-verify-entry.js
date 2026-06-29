// E2E entry that boots the real devtools runtime with custom file types
// configured (template `.qdml` → wxml, style `.qdss` → css, viewScript `.qds`
// → javascript). Proves WorkbenchAppConfig.fileTypes flows end-to-end: into
// dmcc compilation (the page renders) AND into the embedded VS Code workbench
// (the editor classifies the custom extensions). Mirrors workbench-backend-entry.js's
// off-screen handling.
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

electronDeck({
  backend: createDevtoolsBackend({
    appName: 'QDML FileTypes Verify Host',
    fileTypes: { template: ['qdml'], style: ['qdss'], viewScript: ['qds'] },
  }),
}).catch((err) => {
  console.error('[qdml-verify-entry] electronDeck() failed:', err)
})
