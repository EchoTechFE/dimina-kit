import type { Disposable } from '@dimina-kit/electron-deck/main'

/**
 * Generic open/close-gated replay-subscription primitive shared by
 * `createGlobalConsoleMirror` and `createGlobalDiagnosticsMirror` — both
 * gate their subscription to a buffered+replayable source
 * (`ConsoleForwarder`/`DiagnosticsBus`) on whether the standalone "debug the
 * whole Electron app" window is currently open (`onHostChanged`): each open
 * re-subscribes with `{replay:true}` so history is never lost even if the
 * window opens long after boot, and each close disposes that subscription.
 *
 * ── Dedup (the e2e-confirmed bug this fixes) ────────────────────────────────
 * Naively re-subscribing with `{replay:true}` on every reopen double-injects
 * history: Chromium's own per-frame `ConsoleMessageStorage` is NOT cleared by
 * closing DevTools (only by navigation), so it natively re-delivers entries
 * already shown during a PREVIOUS open to the freshly-attached front-end —
 * and if this relay ALSO blindly replays and re-injects the same buffered
 * objects, every entry shown once ends up displayed twice on reopen, the
 * duplicate carrying a fresh (wrong) "just reopened" timestamp instead of
 * when it actually happened.
 *
 * Fix: `state` is a `WeakMap` keyed by OBJECT REFERENCE (never content — two
 * content-identical-but-distinct entries must each still get injected once)
 * that persists across the relay's ENTIRE lifetime, not reset by open/close.
 * A replay that re-delivers an already-CONFIRMED-injected object is skipped;
 * only entries never physically (and successfully) passed to `inject()`
 * before (e.g. ones that arrived while the window was closed) actually call
 * `inject()`. Chromium's own native re-delivery is left to show the
 * once-injected ones — that is what makes reopening not double them up. This
 * also composes correctly with the source's own bounded ring buffer: an
 * evicted entry is simply absent from the next replay batch entirely, so it
 * can never be double-counted regardless of what `state` holds.
 *
 * ── inject() is fallible — only a CONFIRMED success may ever mark "done" ───
 * `inject()` wraps an async `executeJavaScript` against a possibly-destroyed
 * or not-yet-settled target, so it reports whether the entry was ACTUALLY
 * delivered via `boolean | Promise<boolean>`. Marking an entry "injected"
 * before that outcome is known (the original bug here) means a single
 * transient failure — target destroyed, front-end not settled, a rejected
 * `executeJavaScript` — permanently black-holes that entry: every future
 * replay skips it forever, even though it was never actually shown anywhere
 * (violates this repo's "state must be marked at the moment the fact
 * actually happens" principle — this was marking INTENT, not the fact). So
 * `state` tracks three phases per entry: absent (never attempted, or a prior
 * attempt failed and was cleared — eligible for `inject()`), `'pending'`
 * (an `inject()` call is in flight — a concurrent replay of the SAME entry
 * must not trigger a second concurrent call), `'done'` (confirmed success —
 * permanently skipped from here on). A `false` result or a rejection resets
 * the entry back to absent, so the next replay (e.g. the next window reopen)
 * gets a real retry instead of a silent, permanent loss.
 */
export function createOpenGatedRelay<TEntry extends object, THost = unknown>(
  onHostChanged: (handler: (host: THost | null) => void) => () => void,
  subscribe: (sink: (entry: TEntry) => void, opts: { replay: true }) => Disposable,
  inject: (entry: TEntry) => boolean | Promise<boolean>,
): Disposable {
  const state = new WeakMap<TEntry, 'pending' | 'done'>()
  let live: Disposable | null = null

  function deliver(entry: TEntry): void {
    if (state.has(entry)) return
    state.set(entry, 'pending')
    Promise.resolve()
      .then(() => inject(entry))
      .then(
        (ok) => { if (ok) state.set(entry, 'done'); else state.delete(entry) },
        () => { state.delete(entry) },
      )
  }

  const unregister = onHostChanged((host) => {
    live?.dispose()
    live = host !== null ? subscribe(deliver, { replay: true }) : null
  })

  return {
    dispose: () => {
      live?.dispose()
      live = null
      unregister()
    },
  }
}
