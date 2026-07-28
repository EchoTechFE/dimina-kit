// E2E test entry — adds test-only window hiding, then delegates to the
// bundled app entry (dist/main/index.bundle.js) so E2E exercises exactly
// what electron-builder ships (electron-builder.yml extraMetadata.main).
import electron from 'electron'

if (process.env.NODE_ENV === 'test') {
  // macOS activates a newly-launched app (brings it frontmost, steals
  // keyboard focus from whatever the developer running the suite has open)
  // at the process/NSApplication level the moment its first window shows —
  // BEFORE any 'browser-window-created' hook below ever runs, and regardless
  // of any individual BrowserWindow's show()/focus() calls. `app.dock.hide()`
  // switches the app to an accessory activation policy (no Dock icon, never
  // becomes the frontmost app), closing that gap at its actual source instead
  // of only reacting to it per-window after the fact.
  if (process.platform === 'darwin') {
    electron.app.whenReady().then(() => {
      try { electron.app.dock?.hide() } catch {}
    })
  }
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
      // Neutralize focus() itself — reacting to the 'focus' event AFTER it
      // fires only blurs the window back once the OS has already handed it
      // real foreground focus for a moment, stealing it from whatever
      // application the developer running the e2e suite has in the
      // foreground (observed: internal-devtools-window's `open()` calls
      // `win.focus()` explicitly, right after `.show()`, on every test
      // run). Overriding the method itself prevents the steal from ever
      // happening, instead of only shortening it after the fact.
      win.focus = () => { try { win.blur() } catch {} }
    } catch {}
  })
}

await import('../dist/main/index.bundle.js')
