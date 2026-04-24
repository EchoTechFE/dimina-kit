// E2E test entry — adds test-only window hiding, then delegates to the
// bundled app entry (dist/main/index.bundle.js) so E2E exercises exactly
// what electron-builder ships (electron-builder.yml extraMetadata.main).
import electron from 'electron'

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

await import('../dist/main/index.bundle.js')
