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
 * ignore it. It is therefore withheld until the document has finished loading
 * (`window.load`, a real event rather than a guessed delay) with the root
 * still absent; the observer stays armed either way, so a root that mounts
 * even later is still picked up.
 */
export function whenSlotRootReady(
  selector: string,
  missingWarning: string,
  install: (root: HTMLElement) => void,
): void {
  function attempt(): void {
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

    const warnIfStillMissing = (): void => {
      if (!installed) console.warn(missingWarning)
    }
    if (document.readyState === 'complete') warnIfStillMissing()
    else window.addEventListener('load', warnIfStillMissing, { once: true })
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attempt, { once: true })
  } else {
    attempt()
  }
}
