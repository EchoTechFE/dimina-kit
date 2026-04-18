/** A cleanup function that releases a resource. */
export type Disposable = () => void

/**
 * Creates a set of disposable cleanup functions that can be disposed together.
 * Useful for aggregating timer, observer, and event listener cleanup.
 */
export function createDisposableSet(): {
  add: (fn: Disposable) => void
  disposeAll: () => void
} {
  const disposables: Disposable[] = []
  return {
    add: (fn) => disposables.push(fn),
    disposeAll: () => {
      disposables.forEach((fn) => fn())
      disposables.length = 0
    },
  }
}
