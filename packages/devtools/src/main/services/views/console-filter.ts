/**
 * Hides dimina framework internal log lines from the right-panel
 * (user-facing) Console, WITHOUT occupying the panel's visible text-filter
 * box (see console-forward/internal-log.ts for the prefix judge this
 * mirrors). The framework prints these via a plain `console.log` call INSIDE
 * the inspected service host itself; main has no interception point for a
 * native console line (see console-forward/index.ts's header comment), so the
 * lever has to live inside the front-end.
 *
 * ── Why not the text-filter box ──────────────────────────────────────────
 * Writing `-/^\[service\]/` into the Console's filter input does hide the
 * lines, but the string then sits in the box the developer uses for their own
 * filtering: it looks like something they typed, it silently comes back after
 * every re-point (an empty box is indistinguishable from "never set", so
 * clearing it just invites the next injection to rewrite it), and it consumes
 * the one filter slot the panel offers. Driving the panel's own visibility
 * judge instead leaves the box genuinely empty and under the developer's sole
 * control.
 *
 * ── Mechanism ────────────────────────────────────────────────────────────
 * `Console.ConsoleView.instance().filter.currentFilter` is the ConsoleFilter
 * object the panel consults for every message, through its prototype method
 * `shouldBeVisible(viewMessage)`. Wrapping that PROTOTYPE method (not the
 * instance) rejects internal-log lines ahead of the panel's normal logic:
 *   - `currentFilter` is not the only ConsoleFilter the panel judges with:
 *     `ConsoleFilter.clone()` returns `new ConsoleFilter(...)`, and the
 *     sidebar filters through those clones. They share the prototype, so one
 *     patch covers all of them — and keeps covering them if the panel ever
 *     replaces `currentFilter` outright. (Editing the filter box does NOT
 *     replace it today: `ConsoleViewFilter` builds `currentFilter` once in its
 *     constructor and `updateCurrentFilter()` mutates that same instance's
 *     `parsedFilters` / `levelsMask` / `executionContext` in place.)
 *   - The wrapper delegates to the original for everything else, so a
 *     developer's own filter keeps working exactly as before — this only ever
 *     subtracts internal-log lines.
 * Verified end-to-end against the real bundled front-end
 * (e2e/console-filter-live.spec.ts): filter box reads empty, a `[service]`
 * line logged afterwards stays hidden, an ordinary business log stays visible.
 *
 * This patches only the realm of the wc it is injected into — the right-panel
 * front-end. The standalone floating debug window is a separate front-end with
 * its own realm, and its content arrives by a different route entirely
 * (main-side CDP capture → console-forward → global-console-mirror, which is
 * deliberately UNFILTERED), so framework internals stay fully visible there.
 * That window is the escape hatch for anyone who needs to read them.
 *
 * ── Timing ───────────────────────────────────────────────────────────────
 * `Console.ConsoleView` has no lifecycle EVENT marking "fully constructed" —
 * only the checkable condition of whether `.instance()` and the reach into
 * `.filter.currentFilter` throw. The injection therefore retries on a bounded
 * interval (see `LIVE_FILTER_POLL_MAX_ATTEMPTS`/`_INTERVAL_MS`) rather than
 * guessing a fixed delay, and stops as soon as the wrapper is installed.
 *
 * Every tick gates on the front-end bootstrap probe BEFORE touching
 * `ConsoleView.instance()`: an early construction transitively creates
 * IssuesManager and permanently kills the front-end's own bootstrap
 * (`ensureFirst` conflict in MainImpl.#createAppUI) — see
 * frontend-bootstrap-gate.ts for the full mechanism. The main process
 * additionally holds this whole injection behind `whenFrontendBootstrapped`;
 * the in-realm probe is defense in depth for any other caller.
 */

/**
 * First-arg prefix marking a dimina SERVICE-layer framework log. A line counts
 * as internal when its text IS this tag or starts with the tag plus a space —
 * the same shape console-forward/internal-log.ts requires of the first arg, so
 * a business line like '[service]业务状态' stays visible on both sides.
 * These entries are captured
 * directly by the native CDP `Runtime.consoleAPICalled` attach on the service
 * host (service-host/preload.cjs deliberately does not monkeypatch
 * `console.*` there — see its header comment — so there is no main-owned code
 * between the framework's call and the attached DevTools), which is why the
 * front-end is the only place they can be hidden.
 *
 * RENDER-layer framework noise (`[system]`) needs nothing here:
 * `console-forward/index.ts`'s `forwardRenderToServiceHost` gates on
 * `isInternalLogMessage` and never injects those entries into the service
 * host's console at all — filtered at the source, in main-owned code.
 */
export const INTERNAL_LOG_HIDDEN_PREFIX = '[service]'

/** Marker property stamped on the patched prototype, so a re-point re-running
 *  this script wraps once rather than nesting a wrapper per injection. Also
 *  the signal e2e specs read to tell "wrapper installed" from "not yet". */
export const INTERNAL_LOG_WRAPPER_MARK = '__diminaInternalLogHidden'

// Bound on how long the in-realm poll retries before giving up — mirrors this
// module's other bounded waits (e.g. internal-devtools-window's
// CLOSE_WATCHDOG_MS): wait for the real condition, but never forever.
const LIVE_FILTER_POLL_MAX_ATTEMPTS = 100
const LIVE_FILTER_POLL_INTERVAL_MS = 100

/**
 * Build the `executeJavaScript` source that installs the internal-log
 * visibility wrapper described in this module's header comment.
 *
 * Failure is loud but non-fatal: a front-end whose ConsoleFilter prototype has
 * no `shouldBeVisible` (a future Chromium reshuffle) warns once and gives up
 * rather than retrying a structurally absent surface — the panel then simply
 * shows framework lines, which is the pre-existing behavior, not a breakage.
 */
export function buildInternalLogHideScript(hiddenPrefix: string = INTERNAL_LOG_HIDDEN_PREFIX): string {
  const prefixJson = JSON.stringify(hiddenPrefix)
  const markJson = JSON.stringify(INTERNAL_LOG_WRAPPER_MARK)
  const maxAttempts = JSON.stringify(LIVE_FILTER_POLL_MAX_ATTEMPTS)
  const intervalMs = JSON.stringify(LIVE_FILTER_POLL_INTERVAL_MS)
  return `(function(){
    var PREFIX = ${prefixJson};
    var MARK = ${markJson};
    var attempts = 0;
    function bootstrapReady() {
      try {
        var eui = globalThis.EUI;
        if (!eui || !eui.ShortcutRegistry || !eui.ShortcutRegistry.ShortcutRegistry) return false;
        eui.ShortcutRegistry.ShortcutRegistry.instance();
        return true;
      } catch (_) { return false; }
    }
    function isInternalLog(viewMessage) {
      try {
        var msg = viewMessage && typeof viewMessage.consoleMessage === 'function' ? viewMessage.consoleMessage() : null;
        var text = msg ? String(msg.messageText == null ? '' : msg.messageText) : '';
        // Exact tag (the rest of the line is in later arguments), or the tag
        // followed by a space — same shape as main's isInternalLogMessage. A
        // bare prefix test would also swallow '[service]业务状态', an ordinary
        // business log the panel must keep showing.
        return text === PREFIX || text.indexOf(PREFIX + ' ') === 0;
      } catch (_) { return false; }
    }
    function tryApply() {
      attempts++;
      var scheduleRetry = attempts < ${maxAttempts};
      // Distinguishes the two halves of this script when the tail throws:
      // future messages are already handled once the wrapper is on the
      // prototype, even if re-judging the rows already on screen keeps failing.
      var wrapperInstalled = false;
      // In-realm bootstrap probe FIRST (defense in depth on top of the
      // main-process whenFrontendBootstrapped gate): touching
      // Console.ConsoleView.instance() before the front-end's own MainImpl
      // bootstrap completes constructs IssuesManager early and permanently
      // kills that bootstrap (ensureFirst conflict) — the probe throws BEFORE
      // constructing anything, so a not-ready tick costs nothing.
      if (!bootstrapReady()) {
        if (scheduleRetry) { setTimeout(tryApply, ${intervalMs}); return; }
        console.warn('[console-filter] gave up hiding internal logs after ' + attempts + ' attempts — the front-end bootstrap never completed');
        return;
      }
      try {
        var ConsoleNS = globalThis.Console;
        var view = ConsoleNS && ConsoleNS.ConsoleView ? ConsoleNS.ConsoleView.instance() : null;
        var f = view ? view.filter : null;
        var currentFilter = f ? f.currentFilter : null;
        if (!currentFilter) {
          if (scheduleRetry) { setTimeout(tryApply, ${intervalMs}); return; }
          console.warn('[console-filter] gave up hiding internal logs after ' + attempts + ' attempts — Console.ConsoleView never became usable');
          return;
        }
        // The prototype, NOT the instance: clone() mints further ConsoleFilters
        // that judge the same messages, and they all share this one.
        var proto = Object.getPrototypeOf(currentFilter);
        if (!proto || typeof proto.shouldBeVisible !== 'function') {
          console.warn('[console-filter] cannot hide internal logs — ConsoleFilter has no shouldBeVisible to wrap; framework log lines will show in the right panel');
          return;
        }
        if (!proto[MARK]) {
          var original = proto.shouldBeVisible;
          proto.shouldBeVisible = function(viewMessage) {
            if (isInternalLog(viewMessage)) return false;
            return original.apply(this, arguments);
          };
          proto[MARK] = true;
        }
        wrapperInstalled = true;
        // Re-run the panel's visibility pass so lines already on screen when
        // the wrapper lands are re-judged, not just future ones.
        if (view && typeof view.onFilterChanged === 'function') view.onFilterChanged();
      } catch(err) {
        if (scheduleRetry) { setTimeout(tryApply, ${intervalMs}); return; }
        // Name which half survived: a wrapper that installed but could never
        // refresh still hides everything logged from now on, and the panel is
        // left holding the internal lines printed before it landed. Reporting
        // that as plain "gave up" would send the next reader looking for a
        // filter that is in fact working.
        if (wrapperInstalled) {
          console.warn('[console-filter] internal logs are hidden from here on, but the rows already on screen could not be re-judged:', err);
        } else {
          console.warn('[console-filter] gave up hiding internal logs after ' + attempts + ' attempts:', err);
        }
      }
    }
    tryApply();
  })()`
}
