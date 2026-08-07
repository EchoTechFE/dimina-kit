/**
 * Clears the right-panel Console panel's text-filter box on a FRESH project
 * open, together with the stale persisted keys behind it.
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 * The Console filter text is a DevTools-owned setting that DevTools itself
 * persists: it lives on the `devtools://` origin's localStorage, backed by the
 * default session's on-disk storage (verified on disk:
 * `~/Library/Application Support/Dimina DevTools/Local Storage/leveldb` holds a
 * `console.textFilter` entry). An earlier implementation of the internal-log
 * hiding wrote `-/^\[service\]/`-style negative filters straight into the box
 * (see console-filter.ts's header for that history); that value still sits in
 * localStorage and is restored on every project reopen / app restart. We do NOT
 * fight DevTools' persistence mechanism here — instead, on each fresh project
 * open we remove the stale keys and reset the visible box, so a project starts
 * with the developer's own filter surface genuinely empty.
 *
 * ── When it runs ─────────────────────────────────────────────────────────
 * Only the PROJECT-OPEN path arms this (see native-simulator-devtools-host.ts:
 * `attach()` sets the flag; the injection consumes it once). Service-host pool
 * swaps (hot-reload respawn) rebuild the front-end host too, but deliberately do
 * NOT clear — the developer may legitimately have typed a filter during the
 * session and a respawn must not drop in-flight work.
 *
 * ── Discipline (mirrors console-filter.ts) ────────────────────────────────
 * In-realm bootstrap probe before touching `Console.ConsoleView.instance()` (an
 * early construction transitively creates IssuesManager and permanently kills
 * the front-end's own bootstrap — see frontend-bootstrap-gate.ts); bounded
 * retry; silent degradation on any failure. The main process additionally holds
 * this whole injection behind `whenFrontendBootstrapped`.
 */

/**
 * Build the `executeJavaScript` source that clears the Console filter box.
 *
 * Two levers, belt-and-suspenders:
 *   1. remove the stale persisted keys (`console.textFilter` — the on-disk
 *      leftover we actually observed, and its kebab-case sibling) so a Console
 *      view constructed after this script reads an empty setting;
 *   2. reset the already-constructed panel's visible box via
 *      `filter.textFilterUI.setValue('')`, which persists the empty value back
 *      through the panel's own setting path.
 */
export function buildClearConsoleFilterScript(): string {
  return `(function(){
    var attempts = 0;
    var MAX = 100;
    function bootstrapReady() {
      try {
        var eui = globalThis.EUI;
        if (!eui || !eui.ShortcutRegistry || !eui.ShortcutRegistry.ShortcutRegistry) return false;
        eui.ShortcutRegistry.ShortcutRegistry.instance();
        return true;
      } catch (_) { return false; }
    }
    function tryClear() {
      attempts++;
      var scheduleRetry = attempts < MAX;
      if (!bootstrapReady()) {
        if (scheduleRetry) { setTimeout(tryClear, 100); return; }
        return;
      }
      try {
        try { localStorage.removeItem('console.textFilter'); } catch(_) {}
        try { localStorage.removeItem('console.text-filter'); } catch(_) {}
        var ConsoleNS = globalThis.Console;
        var view = ConsoleNS && ConsoleNS.ConsoleView ? ConsoleNS.ConsoleView.instance() : null;
        var f = view ? view.filter : null;
        var box = f && f.textFilterUI;
        if (!box || typeof box.setValue !== 'function' || typeof box.value !== 'function') {
          if (scheduleRetry) { setTimeout(tryClear, 100); return; }
          return;
        }
        var current = box.value();
        if (current) {
          box.setValue('');
          if (typeof f.updateCurrentFilter === 'function') f.updateCurrentFilter();
          if (typeof f.onFilterChanged === 'function') f.onFilterChanged();
        }
      } catch(_) {
        if (scheduleRetry) setTimeout(tryClear, 100);
      }
    }
    tryClear();
  })()`
}
