import type { WebContents } from 'electron'
import { shell } from 'electron'
import path from 'path'
import { pathToFileURL } from 'url'

/**
 * Navigation hardening for every WebContents created by the host application
 * (main window renderer, settings overlay, popover overlay, standalone
 * settings window). These WebContents load the contextBridge-exposing main
 * preload, so an unintended navigation out of the renderer bundle would
 * expose `window.devtools.ipc` to a foreign origin.
 *
 * `applyNavigationHardening` installs:
 *  - `setWindowOpenHandler`: deny popups; route http(s) through the OS browser.
 *  - `will-navigate`: cancel any in-place navigation outside `rendererDir`;
 *    route http(s) through the OS browser.
 */

/** Default popup handler: open http(s) externally, deny everything else. */
export function handleWindowOpenExternal(url: string): { action: 'deny' } {
  try {
    const u = new URL(url)
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      void shell.openExternal(url)
    }
  } catch {
    /* malformed URL — fall through to deny */
  }
  return { action: 'deny' }
}

/**
 * Install `setWindowOpenHandler` + `will-navigate` on `wc` so it can only
 * navigate to `file://` URLs under `rendererDir`. Safe to call once per
 * WebContents.
 */
export function applyNavigationHardening(
  wc: WebContents,
  rendererDir: string,
): void {
  const rendererPrefix = pathToFileURL(rendererDir + path.sep).href

  wc.setWindowOpenHandler(({ url }) => handleWindowOpenExternal(url))

  wc.on('will-navigate', (event, url) => {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      event.preventDefault()
      return
    }
    if (parsed.protocol === 'file:' && parsed.href.startsWith(rendererPrefix)) {
      return
    }
    event.preventDefault()
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      void shell.openExternal(url)
    }
  })
}
