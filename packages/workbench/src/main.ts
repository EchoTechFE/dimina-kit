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
import { walAuditSource } from './workspace/wal-audit'
import type { WalAuditSurface } from './workspace/wal-audit'
import type { CustomFileTypes } from './file-type-associations'

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
    /**
     * fs-core WAL audit surface (turnBegin/turnEnd/agentWrite/agentRm/diff/rollback)
     * layered on top of the disk-mirror save path — see `walAuditSource`. Follows
     * the same `window.__WB_*` CDP-reachable convention as the rest of this probe
     * surface (`__WB_STATUS`/`__WB_PROBE`), for a future agent host to drive over
     * `executeJavaScript`. Disk/git stay the source of truth; this is bookkeeping
     * on top, degrading to `undefined`-method-free-but-rejecting calls if the
     * OPFS ledger failed to initialize (see wal-audit.ts).
     */
    __WB_AUDIT?: WalAuditSurface
  }
}

/** Devtools color scheme passed via `index.html?theme=light|dark`; dark default. */
function initialThemeScheme(): 'light' | 'dark' {
  return new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark'
}

/**
 * Pull the host's custom file types from the COI server's `/__filetypes`
 * endpoint (the same bridge that serves `/__fs` + `/__contrib`). Best-effort:
 * a missing endpoint, non-OK status, or parse error → undefined (built-in
 * associations only), so the editor still boots.
 */
async function loadFileTypes(): Promise<CustomFileTypes | undefined> {
  try {
    const res = await fetch('/__filetypes')
    if (!res.ok) return undefined
    return (await res.json()) as CustomFileTypes
  } catch {
    return undefined
  }
}

async function boot(): Promise<void> {
  const container = document.getElementById('workbench')!
  // The page is served from the COI server root, so its origin is the fs bridge base.
  const fsBaseUrl = location.origin + '/'

  const workspace = walAuditSource(diskMirrorSource({ fsBaseUrl }), { fsBaseUrl })

  const handle = await bootWorkbench({
    container,
    workspace,
    theme: initialThemeScheme(),
    fileTypes: await loadFileTypes(),
    exposeProbe: true,
    onStatus: (s) => {
      window.__WB_STATUS = s
    },
  })

  window.__WB_SET_THEME = handle.setTheme
  window.__WB_AUDIT = workspace.audit

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
