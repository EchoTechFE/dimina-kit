// E2E test entry — adds test-only window hiding, then delegates to the
// real app entry (dist/main/index.js) so dev/build/E2E share one codepath.
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

await import('../dist/main/index.js')
