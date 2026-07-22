/**
 * Negative text-filter for the right-panel (user-facing) Console — hides
 * dimina framework internal log lines from the panel the mini-app author
 * watches (see console-forward/internal-log.ts for
 * the prefix judge this mirrors). The framework prints these via a plain
 * `console.log` call INSIDE the inspected service host itself; main has no
 * interception point for a native console line (see
 * console-forward/index.ts's header comment) — the only lever available is
 * the front-end's OWN Console filter setting.
 *
 * ── Mechanism ────────────────────────────────────────────────────────────
 * The Console panel's text filter is a Global/Synced DevTools setting. On
 * Chromium ~146 (post-M125 kebab-case renaming) that means TWO things a
 * naive `localStorage['console.textFilter']` write gets both wrong:
 *   1. The real setting name is kebab-case: `console.text-filter`.
 *   2. Global/Synced settings are NOT backed by `window.localStorage` at
 *      all — they go through `InspectorFrontendHost.getPreferences`
 *      (async-callback read) / `.setPreference(key, jsonValue)` (sync
 *      write). Values are themselves JSON-stringified (e.g. `'"elements"'`
 *      for a string preference) — never a `localStorage` entry.
 * (An earlier version of this comment cited `localStorage['panel-selectedTab']`
 * as a "proven working" precedent for the localStorage approach — that was
 * itself a misreading: the console-default tab selection actually works via
 * a LIVE `UI.ViewManager.instance().showView('console')` call, not a
 * persisted setting; see native-simulator-devtools-host.ts's console-default
 * injection, which has since dropped the dead localStorage line alongside
 * this fix.)
 *
 * ── Disk persistence: verified NOT to apply to this custom host ───────────
 * A dedicated isolated e2e (`e2e/_diagnose-inspector-frontend-host.spec.ts`,
 * clean `electronApp.close()` — not `kill -9`, which never lets Electron
 * flush prefs and would confound the result) confirms `setPreference`/
 * `getPreferences` DO round-trip correctly in-process (this function's
 * output was read back byte-for-byte via the real production code path),
 * but for THIS custom devtools:// front-end host (a plain BrowserWindow we
 * point at `devtools://` ourselves, not Electron's native
 * `webContents.openDevTools()`) nothing under `electron.devtools.preferences`
 * — not even `panel-selected-tab` — survives to the on-disk Preferences
 * file on a clean shutdown. That's fine for this function's purpose: every
 * fresh launch starts with `existing === undefined`, so the `isUnset` branch
 * always (re-)applies the default — exactly the desired "always filtered by
 * default" behavior. The self-healing "stale mark" branch below still
 * matters WITHIN a single running process (e.g. re-pointing the front-end at
 * a new service host mid-session), where `getPreferences` reflects whatever
 * was `setPreference`d earlier in that same process, including a real user
 * customization typed into the filter box.
 *
 * `setPreference` values are themselves JSON-stringified (matching the
 * `'"elements"'` shape observed above). A NEGATIVE filter (`-/regex/`) is
 * DevTools' own "hide lines matching" syntax (the same `-` prefix a user
 * types into the filter box themselves).
 *
 * Only overwrites when the user hasn't set their OWN filter — never clobber
 * a real choice with this default. Re-injected on every (re)point like
 * customizeDevtoolsTabs, so a service-host pool swap re-applies it.
 *
 * Self-healing default: a companion `…dimina-default` key marks the value WE
 * last wrote. If `console.text-filter` still equals that mark, it is our own
 * prior default going stale (e.g. this DEFAULT_INTERNAL_LOG_FILTER regex
 * changing between releases), not a real user choice — safe to overwrite. A
 * value that differs from the mark is the user's own customization and is
 * left untouched. Without this, "only write when unset" permanently freezes
 * whatever default first got written (real dev-machine finding: an older
 * build's regex, missing the `[视图] ` prefix, survived across rebuilds and
 * silently never updated).
 *
 * This only covers the persisted setting a FRESH (not-yet-constructed)
 * Console panel reads at boot — the timing `applyConsoleFilter` actually
 * runs at (right after a fresh `openDevTools()`, before the front-end has
 * finished booting panels; see native-simulator-devtools-host.ts). It does
 * NOT reactively update an ALREADY-open, already-constructed Console panel's
 * live filter box; that would need driving the front-end's live
 * `Common.Settings` object directly (the same live-API-driving family as
 * `showView()`/`registerViewExtension` in devtools-tabs.ts), which isn't
 * implemented here since the one real call site always applies this before
 * the front-end has booted.
 */

/**
 * DevTools negative-filter regex hiding the dimina framework's internal-log
 * lines (see console-forward/internal-log.ts's prefix judge) that have NO
 * other interception point: SERVICE-layer entries (`^\[service\]`) are
 * captured directly by the native CDP `Runtime.consoleAPICalled` attach on
 * the service host (service-host/preload.cjs deliberately does not
 * monkeypatch `console.*` there — see its header comment — so there is no
 * main-owned code between the framework's call and the attached DevTools).
 * This front-end filter is genuinely the only lever available for that half.
 *
 * RENDER-layer framework noise (`[system]`) no longer needs this filter:
 * `console-forward/index.ts`'s `forwardRenderToServiceHost` now gates on
 * `isInternalLogMessage` and simply never injects those entries into the
 * service host's console at all — filtered at the source (main-owned code),
 * so they never reach the right panel regardless of what a user types into
 * this box. `-/…/ ` is DevTools' own "exclude" filter syntax.
 */
export const DEFAULT_INTERNAL_LOG_FILTER = '-/^\\[service\\]/'

/**
 * Build the `executeJavaScript` source that seeds the Console panel's
 * negative filter via `InspectorFrontendHost`, unless the user already set
 * one of their own (or our own prior default has been customized away from).
 */
export function buildConsoleFilterScript(negativeFilter: string = DEFAULT_INTERNAL_LOG_FILTER): string {
  const keyJson = JSON.stringify('console.text-filter')
  const markKeyJson = JSON.stringify('console.text-filter.dimina-default')
  // The stored preference value is itself JSON-stringified (mirrors the
  // real host's own `'"elements"'`-shaped entries).
  const valueJsonLiteral = JSON.stringify(JSON.stringify(negativeFilter))
  return `(function(){try{
    var IFH = globalThis.InspectorFrontendHost;
    if (!IFH || typeof IFH.getPreferences !== 'function' || typeof IFH.setPreference !== 'function') return;
    IFH.getPreferences(function(prefs){
      try {
        var KEY = ${keyJson};
        var MARK_KEY = ${markKeyJson};
        var VALUE = ${valueJsonLiteral};
        var existing = prefs ? prefs[KEY] : undefined;
        var mark = prefs ? prefs[MARK_KEY] : undefined;
        var isUnset = existing === undefined || existing === null || existing === '' || existing === '""';
        var isOurStaleDefault = !isUnset && mark !== undefined && mark !== null && existing === mark;
        if (isUnset || isOurStaleDefault) {
          IFH.setPreference(KEY, VALUE);
          IFH.setPreference(MARK_KEY, VALUE);
        }
      } catch(_){}
    });
  }catch(_){}})()`
}
