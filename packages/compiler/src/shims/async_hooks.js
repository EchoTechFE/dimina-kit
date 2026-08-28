// node:async_hooks shim for the browser build.
//
// Used by dmcc's env.js purely to isolate one build's pathInfo/configInfo/
// dependencyGraph from another via AsyncLocalStorage.run()/getStore() — real
// continuation tracking (the reason Node needs a dedicated async_hooks API)
// is never exercised here: each browser bundle instance is loaded into its
// own worker realm (see browser-entry.js) and that worker drives exactly one
// build to completion before starting the next, so run() calls never
// interleave within a realm. A plain call stack reproduces getStore()'s
// "innermost active run()" semantics for that single-flight usage without
// needing real continuation-local tracking.
export class AsyncLocalStorage {
  #stack = []

  getStore() {
    return this.#stack.at(-1)
  }

  run(store, callback, ...args) {
    this.#stack.push(store)
    let result
    try {
      result = callback(...args)
    }
    catch (err) {
      this.#stack.pop()
      throw err
    }
    // dmcc's only caller wraps an async build (env.js's runWithCompilerContext),
    // so the store must stay on the stack until that returned promise SETTLES —
    // popping right after the synchronous call returns would drop the context
    // before any of the callback's own `await`s resume and call getStore().
    if (result && typeof result.then === 'function') {
      return result.finally(() => this.#stack.pop())
    }
    this.#stack.pop()
    return result
  }
}

export default { AsyncLocalStorage }
