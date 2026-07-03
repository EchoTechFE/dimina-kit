import type { WebContents } from 'electron'

/**
 * Deferred executeJavaScript scheduling for a LOADING webContents.
 *
 * `wc.executeJavaScript()` against a loading wc queues one internal
 * `did-stop-loading` waiter PER CALL (Electron defers the eval). Call sites
 * that re-inject on every re-point (open-in-editor glue, tab customization,
 * console default) can fire dozens of times within one front-end load window —
 * piling waiters past the MaxListeners ceiling on the host wc.
 *
 * This injector keeps AT MOST ONE `did-stop-loading` hook per (wc, kind) per
 * load window; repeated schedules within the window only REPLACE the runner
 * (latest-wins — a re-point that swaps the inspected service wc must win over
 * the stale closure). A non-loading wc runs immediately.
 */
export interface LoadDeferredInjector {
  (wc: WebContents, kind: string, run: () => void): void
}

/**
 * THE single settled-predicate for the DevTools front-end host wc — every
 * module that fires `executeJavaScript` at it (deferred injects here, the
 * Elements reconcile tick + pushes, the Network dispatch flush) must consult
 * THIS predicate, never its own `isLoading()` probe.
 *
 * It is AT LEAST as strict as Electron's internal
 * `waitTillCanExecuteJavaScript` gate (`getURL() && !isLoadingMainFrame()`,
 * lib/browser/api/web-contents.ts): whenever this predicate reads settled,
 * Electron executes immediately and queues NO did-stop-loading waiter. A laxer
 * probe (bare `isLoading()`) opens a divergence window where the caller
 * believes the wc is idle while Electron still queues one waiter per call,
 * piling toward the MaxListeners ceiling. Two DELIBERATE extra strictures on
 * top of Electron's gate:
 * - `about:blank` reads unsettled — it satisfies Electron's check, but a
 *   script run against it is wiped by the upcoming real navigation;
 * - probes are reflective (try/catch, isLoading fallback): a partial test wc
 *   degrades to "unsettled", mirroring the surrounding modules'
 *   degrade-silently convention.
 */
export function isFrontendSettled(wc: WebContents): boolean {
  try {
    if (wc.isDestroyed()) return false
    const url = wc.getURL()
    const mainFrameLoading = typeof wc.isLoadingMainFrame === 'function'
      ? wc.isLoadingMainFrame()
      : wc.isLoading()
    return !mainFrameLoading && url !== '' && url !== 'about:blank'
  } catch {
    return false
  }
}

export function createLoadDeferredInjector(): LoadDeferredInjector {
  const pending = new WeakMap<WebContents, Map<string, () => void>>()

  return function injectWhenReady(wc, kind, run) {
    if (wc.isDestroyed()) return
    if (isFrontendSettled(wc)) {
      run()
      return
    }
    let kinds = pending.get(wc)
    if (!kinds) {
      kinds = new Map()
      pending.set(wc, kinds)
    }
    const alreadyHooked = kinds.has(kind)
    kinds.set(kind, run)
    if (alreadyHooked) return
    wc.once('did-stop-loading', () => {
      const runner = kinds.get(kind)
      kinds.delete(kind)
      if (!runner || wc.isDestroyed()) return
      runner()
    })
  }
}
