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
 * This covers the persisted setting a FRESH (not-yet-constructed) Console
 * panel would read at boot. It does NOT by itself update an
 * ALREADY-constructed Console panel's live filter box — real-machine
 * evidence (empirical probe against the actual bundled Console panel, this
 * session) showed the panel's own async bootstrap (Settings storage wiring,
 * i18n, ActionRegistry, …) can still be constructing itself well after
 * `applyConsoleFilter`'s injection point (right after `openDevTools()`,
 * gated on `did-stop-loading` — the top document finishing load, NOT the
 * front-end's own panel construction), so this preference write can land
 * before OR after the panel reads it, and a "before" write does nothing for
 * that already-visible filter box. `buildLiveConsoleFilterScript` below
 * closes that gap by driving the panel's live filter object directly, with a
 * bounded poll (no fixed delay — there is no public "Console panel
 * constructed" event to await, only a checkable condition) standing in for
 * the missing event this repo's own conventions call for.
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

// Bound on how long `buildLiveConsoleFilterScript`'s in-realm poll retries
// before giving up — mirrors this module's other bounded waits (e.g.
// internal-devtools-window's CLOSE_WATCHDOG_MS): wait for the real condition,
// but never forever. `Console.ConsoleView` was observed (real-machine probe,
// this session) fully constructible well within a few seconds of the
// front-end's document settling; this leaves generous headroom.
const LIVE_FILTER_POLL_MAX_ATTEMPTS = 100
const LIVE_FILTER_POLL_INTERVAL_MS = 100

/**
 * Build the `executeJavaScript` source that drives the Console panel's LIVE
 * filter object directly — the fix for the gap `buildConsoleFilterScript`'s
 * persisted-preference write cannot close (see this module's header
 * comment). Empirically discovered live API (real-machine probe against the
 * actual bundled `devtools://` Console panel, this session — not a guess):
 *   `Console.ConsoleView.instance().filter` exposes `textFilterUI` (the
 *   visible input box — `.setValue(text)` updates what the user sees) and
 *   `updateCurrentFilter()` / `onFilterChanged()` (re-parses the box's value
 *   into the filter actually applied to messages, and re-applies it to
 *   already-shown AND future messages). Verified end-to-end: after this
 *   sequence, a fresh `[service]`-prefixed message logged afterward is
 *   immediately hidden, matching the already-shown ones.
 *
 * Same "don't clobber a real user choice" contract as
 * `buildConsoleFilterScript`, judged against the LIVE box value instead of a
 * persisted one: only applies when the box currently reads empty (unset) or
 * already equals this exact default (re-applying is a harmless no-op,
 * correctly handles a re-point re-running this script against a panel that
 * already has it applied).
 *
 * `Console.ConsoleView` has no lifecycle EVENT marking "fully constructed" —
 * only the checkable condition of whether calling `.instance()` and reaching
 * into `.filter.textFilterUI` throws. Retries on a bounded interval (see
 * `LIVE_FILTER_POLL_MAX_ATTEMPTS`/`_INTERVAL_MS`) rather than a single fixed
 * delay, and stops immediately on either success or a detected user
 * customization — it does not keep polling once there is nothing left to do.
 *
 * Every tick gates on the front-end bootstrap probe BEFORE touching
 * `ConsoleView.instance()`: an early construction transitively creates
 * IssuesManager and permanently kills the front-end's own bootstrap
 * (`ensureFirst` conflict in MainImpl.#createAppUI) — see
 * frontend-bootstrap-gate.ts for the full mechanism. The main process
 * additionally holds this whole injection behind `whenFrontendBootstrapped`;
 * the in-realm probe is defense in depth for any other caller of this
 * script builder.
 */
export function buildLiveConsoleFilterScript(negativeFilter: string = DEFAULT_INTERNAL_LOG_FILTER): string {
  const filterJson = JSON.stringify(negativeFilter)
  const maxAttempts = JSON.stringify(LIVE_FILTER_POLL_MAX_ATTEMPTS)
  const intervalMs = JSON.stringify(LIVE_FILTER_POLL_INTERVAL_MS)
  return `(function(){
    var VALUE = ${filterJson};
    var attempts = 0;
    function bootstrapReady() {
      try {
        var eui = globalThis.EUI;
        if (!eui || !eui.ShortcutRegistry || !eui.ShortcutRegistry.ShortcutRegistry) return false;
        eui.ShortcutRegistry.ShortcutRegistry.instance();
        return true;
      } catch (_) { return false; }
    }
    function tryApply() {
      attempts++;
      var scheduleRetry = attempts < ${maxAttempts};
      // In-realm bootstrap probe FIRST (defense in depth on top of the
      // main-process whenFrontendBootstrapped gate): touching
      // Console.ConsoleView.instance() before the front-end's own
      // MainImpl bootstrap completes constructs IssuesManager early and
      // permanently kills that bootstrap (ensureFirst conflict) — the probe
      // throws BEFORE constructing anything, so a not-ready tick costs
      // nothing and never touches ConsoleView.
      if (!bootstrapReady()) {
        if (scheduleRetry) { setTimeout(tryApply, ${intervalMs}); return; }
        console.warn('[console-filter] gave up applying the live Console filter after ' + attempts + ' attempts — the front-end bootstrap never completed');
        return;
      }
      try {
        var ConsoleNS = globalThis.Console;
        var view = ConsoleNS && ConsoleNS.ConsoleView ? ConsoleNS.ConsoleView.instance() : null;
        var f = view ? view.filter : null;
        if (!f || !f.textFilterUI || typeof f.textFilterUI.setValue !== 'function' || typeof f.textFilterUI.value !== 'function') {
          if (scheduleRetry) { setTimeout(tryApply, ${intervalMs}); return; }
          console.warn('[console-filter] gave up applying the live Console filter after ' + attempts + ' attempts — Console.ConsoleView never became usable');
          return;
        }
        var current = f.textFilterUI.value();
        var isUnset = current === undefined || current === null || current === '';
        var isOurDefault = current === VALUE;
        if (isUnset || isOurDefault) {
          f.textFilterUI.setValue(VALUE);
          if (typeof f.updateCurrentFilter === 'function') f.updateCurrentFilter();
          if (typeof f.onFilterChanged === 'function') f.onFilterChanged();
        }
        // Either applied, or a real user customization was detected — both
        // are terminal: nothing left for a later retry to accomplish.
      } catch(_) {
        if (scheduleRetry) setTimeout(tryApply, ${intervalMs});
      }
    }
    tryApply();
  })()`
}
