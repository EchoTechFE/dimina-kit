/**
 * Prebuilt static-bundle entry for the devtools embedded editor.
 *
 * This is the page the devtools COI server serves: a disk-mirrored workbench
 * (its file source is the active project, read/written over the COI `/__fs`
 * bridge) with all dimina language features on. The reusable boot lives in
 * `bootWorkbench`; this entry only wires the devtools host specifics — the
 * disk-mirror source keyed off the COI origin, the theme passed via the page
 * URL query, and the `window.__WB_*` probe/status surface the harness and the
 * main process drive over CDP / executeJavaScript.
 */
import { bootWorkbench } from './boot'
import { diskMirrorSource } from './workspace/disk-mirror'

declare global {
  interface Window {
    __WB_STATUS?: string
    __WB_ERROR?: string
    /**
     * Apply a devtools color scheme to the workbench. The main process drives
     * this over `executeJavaScript` whenever the devtools theme flips so the
     * editor tracks the surrounding app's light/dark scheme.
     */
    __WB_SET_THEME?: (scheme: 'light' | 'dark') => void
  }
}

/** Devtools color scheme passed via `index.html?theme=light|dark`; dark default. */
function initialThemeScheme(): 'light' | 'dark' {
  return new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark'
}

async function boot(): Promise<void> {
  const container = document.getElementById('workbench')!
  // The page is served from the COI server root, so its origin is the fs bridge base.
  const fsBaseUrl = location.origin + '/'

  const handle = await bootWorkbench({
    container,
    workspace: diskMirrorSource({ fsBaseUrl }),
    theme: initialThemeScheme(),
    exposeProbe: true,
    onStatus: (s) => {
      window.__WB_STATUS = s
    },
  })

  window.__WB_SET_THEME = handle.setTheme

  const bootEl = document.getElementById('boot')
  if (bootEl) bootEl.remove()
}

boot().catch((err) => {
  window.__WB_ERROR = String(err && (err as Error).stack ? (err as Error).stack : err)
  window.__WB_STATUS = 'error'
  const bootEl = document.getElementById('boot')
  if (bootEl) bootEl.textContent = 'workbench boot error: ' + window.__WB_ERROR
  console.error('[workbench] boot failed', err)
})
