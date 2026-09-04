/**
 * Shared readiness wait for a host-slot content's shrink-to-fit measurement
 * root (`[data-host-*-root]`). A one-shot `document.querySelector` at
 * `DOMContentLoaded` time only works when the root is present in the initial
 * HTML. Framework-rendered content (e.g. a React app) can mount its root
 * asynchronously, after `DOMContentLoaded` has already fired — a one-shot
 * check misses it permanently and the slot's width/height is never
 * advertised. This keeps watching via `MutationObserver` instead of assuming
 * a synchronous mount, without polling on a fixed delay.
 *
 * The "root is missing" warning exists for downstream authors who forgot the
 * element entirely, so it must not fire on the healthy async-mount path — a
 * warning printed on every normal load is noise that trains its readers to
 * ignore it. Two conditions gate it, both signals rather than guessed delays:
 * the document must be one the host actually loaded content into (not the
 * view's own blank document), and it must have finished loading AND run out of
 * pending work (`window.load`, then an idle callback — a framework's first
 * commit is normal-priority work, so it always lands before idle). The
 * observer stays armed either way, so a root that mounts even later is still
 * picked up.
 */
export function whenSlotRootReady(
  selector: string,
  missingWarning: string,
  install: (root: HTMLElement) => void,
): void {
  function attempt(): void {
    // The slot's WebContentsView holds its own empty document until the host
    // loads content into it, and this preload runs there too. That document
    // has no author: a missing root in it is not a mistake anyone made, and
    // warning about it fires on every app start. The observer below still gets
    // armed, so content that does arrive is picked up.
    const authored = location.href !== 'about:blank' && location.href !== ''

    const root = document.querySelector<HTMLElement>(selector)
    if (root) {
      install(root)
      return
    }

    let installed = false
    const observer = new MutationObserver(() => {
      const lateRoot = document.querySelector<HTMLElement>(selector)
      if (!lateRoot) return
      observer.disconnect()
      installed = true
      install(lateRoot)
    })
    observer.observe(document.documentElement, { childList: true, subtree: true })

    // Re-queries rather than trusting `installed`: the observer delivers on a
    // microtask, so a root that is already in the DOM may not have been
    // installed yet — it is present either way, which is what the warning is
    // about.
    const warnIfStillMissing = (): void => {
      if (installed || !authored || document.querySelector(selector)) return
      console.warn(missingWarning)
    }

    // `load` alone is too early a verdict: a concurrent React root commits its
    // first render on a scheduler task that can land after it, and the warning
    // would then race the healthy mount it is supposed to ignore. Idle
    // callbacks run only once the main thread has no pending work of that
    // kind, so a root still absent then is genuinely absent. The timeout is
    // the cap for a page that never goes idle, not the mechanism.
    const decide = (): void => {
      const idle = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number })
        .requestIdleCallback
      if (typeof idle === 'function') idle(warnIfStillMissing, { timeout: 5_000 })
      else warnIfStillMissing()
    }
    if (document.readyState === 'complete') decide()
    else window.addEventListener('load', decide, { once: true })
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attempt, { once: true })
  } else {
    attempt()
  }
}
