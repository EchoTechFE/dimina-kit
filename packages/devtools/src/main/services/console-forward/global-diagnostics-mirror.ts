import type { WebContents } from 'electron'
import type { Disposable } from '@dimina-kit/electron-deck/main'
import type { Diagnostic, DiagnosticsBus } from '../diagnostics/index.js'
import { isFrontendSettled } from '../views/inject-when-ready.js'
import { createOpenGatedRelay } from './open-gated-relay.js'

/** `Diagnostic.severity` → the literal `console.<method>` call — same mapping
 *  console-forward/index.ts's DIAGNOSTIC_CONSOLE_CALL uses (kept local since
 *  that constant isn't exported; both must stay in sync with `Diagnostic`). */
const DIAGNOSTIC_CONSOLE_CALL: Record<Diagnostic['severity'], string> = {
  error: 'console.error',
  warn: 'console.warn',
  info: 'console.info',
}

/**
 * Build the `executeJavaScript` source that injects one diagnostic into the
 * target wc's own console, prefixed `[dimina-kit] ` — same shape as
 * console-forward/index.ts's `buildDiagnosticScript`, minus that function's
 * `RENDER_FORWARD_SOURCE_URL` loop-safety sentinel: that sentinel exists to
 * stop the service-host's OWN CDP capture from re-broadcasting the injected
 * line, and nothing here re-captures `mainWindow.webContents`'s console.
 */
function buildMirrorScript(severity: Diagnostic['severity'], message: string): string {
  const call = DIAGNOSTIC_CONSOLE_CALL[severity]
  const argsJson = JSON.stringify([`[dimina-kit] ${message}`])
  return `(()=>{try{const a=JSON.parse(${JSON.stringify(argsJson)});${call}(...a)}catch(_){}})()`
}

/**
 * Mirror EVERY diagnostic (both `audience:'user'` and `audience:'internal'`,
 * UNFILTERED — the same "see everything" contract `createGlobalConsoleMirror`
 * applies to guest console entries) into `target`'s own console, but ONLY
 * while the standalone internal DevTools window is open.
 *
 * The subscription lifecycle is gated by `onHostChanged` (non-null hostWc =
 * window just opened/rebuilt, null = just closed) rather than subscribing
 * once for the whole app lifetime: each open re-subscribes to `diagnostics`
 * with `{replay:true}`, draining its CURRENT buffer into `target` before
 * continuing live, and each close disposes that subscription. This is what
 * makes opening (or reopening) the window always show history — subscribing
 * once at construction time (this module's earlier design) captured the
 * replay burst before any window could possibly be open to receive it
 * (construction happens at app boot; the window is user-opened, always
 * later), silently losing it forever — the exact reported bug (e.g. the
 * earliest compile-standby events at boot never showing up). `target` is the
 * fixed INSPECTED side (mainWindow.webContents) — never the hostWc the
 * signal carries.
 *
 * Reopen-dedup is handled by `createOpenGatedRelay` (real-machine e2e
 * confirmed a naive replay-on-every-open double-injects everything already
 * shown once, since Chromium's own console storage survives a DevTools
 * close — see that module's doc comment).
 */
export function createGlobalDiagnosticsMirror(
  diagnostics: Pick<DiagnosticsBus, 'subscribe'>,
  target: WebContents,
  onHostChanged: (handler: (hostWc: WebContents | null) => void) => () => void,
): Disposable {
  function inject(d: Diagnostic): boolean | Promise<boolean> {
    if (target.isDestroyed()) return false
    if (!isFrontendSettled(target)) return false
    // Report the real outcome — createOpenGatedRelay only marks an entry
    // permanently "injected" on a confirmed `true`; a silently-swallowed
    // rejection used to black-hole diagnostics forever (see that module's
    // doc comment). Still surface the failure somewhere observable instead
    // of a bare `.catch(() => {})`.
    return target.executeJavaScript(buildMirrorScript(d.severity, d.message), true).then(
      () => true,
      (err) => {
        console.warn('[global-diagnostics-mirror] injection failed, will retry on next reopen:', err instanceof Error ? err.message : String(err))
        return false
      },
    )
  }

  return createOpenGatedRelay<Diagnostic, WebContents>(
    onHostChanged,
    (sink, opts) => diagnostics.subscribe(sink, opts),
    inject,
  )
}
