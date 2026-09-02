/**
 * Every failure a pool rejects with carries `err.code`, and this is the whole set of
 * values — from the argument check on the way in to the last copy on the way out. (A
 * bug inside the pool itself still surfaces as a plain TypeError; that is a defect
 * here, not a category a host should branch on.) Hosts branch on the code: an
 * infrastructure failure is worth retrying on a fresh worker or falling back to
 * another compile path, a compile error must be shown to the user as-is. Without a
 * code the only way to tell those apart is matching the error message text, which
 * silently stops working the moment a message is reworded — including messages that
 * come from the browser, not from this package (a failed dynamic import, an aborted
 * wasm fetch).
 *
 * Re-exported from `@dimina-kit/compiler/pool` and `@dimina-kit/compiler/pool-node`,
 * so a host imports the constants instead of copying the strings.
 */
export const COMPILER_ERROR_CODES = Object.freeze({
  /** The compiler rejected the project: source or config the user has to fix. Retrying changes nothing. */
  stageError: 'compiler-stage-error',
  /** A stage worker could not `import(toolchainSetupURL)` — module 404, network down, wasm unreachable. */
  toolchainSetupFailed: 'compiler-toolchain-setup-failed',
  /** The worker went silent past its inactivity window (a wedged wasm loop blocks even heartbeats). */
  workerTimeout: 'compiler-worker-timeout',
  /** The worker died: an `error` event, a `postMessage` throw, or an unexpected exit. */
  workerCrashed: 'compiler-worker-crashed',
  /** A request reached a slot already judged dead, before it was respawned. */
  workerDead: 'compiler-worker-dead',
  /** Node only: esbuild's resident service died, so every call in that realm fails from now on. */
  toolchainDead: 'compiler-toolchain-dead',
  /**
   * Node only: the toolchain is not in the installed app at all — oxc-parser resolves no
   * runtime binding for this platform, or esbuild's binary sits inside app.asar where it
   * cannot be spawned. The host's packaging is what has to change; a fresh worker does
   * not help, but another compile path (a separately installed dmcc) still can.
   */
  toolchainUnavailable: 'compiler-toolchain-unavailable',
  /** Node only: the project compiled, copying the staging dir to outputDir did not (permissions, full disk). */
  outputWriteFailed: 'compiler-output-write-failed',
  /** The call itself was wrong — e.g. `compile()` with no files. The caller's bug, not the project's. */
  invalidInput: 'compiler-invalid-input',
  /** The pool was disposed; nothing will be compiled on it again. */
  poolDisposed: 'compiler-pool-disposed',
})

const CODE_VALUES = new Set(Object.values(COMPILER_ERROR_CODES))

/**
 * Is this one of the published codes? The pool uses it as a gate on codes that arrive
 * from a worker: whatever a worker reply claims, only a value from the table above
 * reaches the host, so a stray runtime code (a memfs `ENOENT`) cannot pass itself off
 * as something hosts branch on.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isCompilerErrorCode(value) {
  return CODE_VALUES.has(/** @type {string} */ (value))
}

/**
 * A Set a host can read but not change. `Object.freeze` alone does not do this: a frozen
 * Set still takes `.add()` and `.delete()`, and the sets below drive the pool's OWN retry
 * decisions — one `.add()` in host code would quietly change when this package retries.
 * @param {string} name
 * @param {string[]} values
 * @returns {Set<string>}
 */
function readonlyCodeSet(name, values) {
  const set = new Set(values)
  for (const method of ['add', 'delete', 'clear']) {
    Object.defineProperty(set, method, {
      value: () => { throw new TypeError(`${name} is read-only`) },
      writable: false,
      configurable: false,
    })
  }
  return Object.freeze(set)
}

/**
 * Failures of the machinery rather than of the project: a fresh worker, or a different
 * compile path, has a real chance of succeeding. `compiler-stage-error` is deliberately
 * absent — re-running a broken project just hides the diagnostic the user needs.
 */
export const INFRASTRUCTURE_ERROR_CODES = readonlyCodeSet('INFRASTRUCTURE_ERROR_CODES', [
  COMPILER_ERROR_CODES.toolchainSetupFailed,
  COMPILER_ERROR_CODES.toolchainDead,
  COMPILER_ERROR_CODES.toolchainUnavailable,
  COMPILER_ERROR_CODES.workerTimeout,
  COMPILER_ERROR_CODES.workerCrashed,
  COMPILER_ERROR_CODES.workerDead,
])

/**
 * The pool's own retry predicate: these mean the worker is gone, so replaying the whole
 * attempt on a respawned one is safe. Narrower than {@link INFRASTRUCTURE_ERROR_CODES},
 * which also covers failures a *host* may want to react to without the pool retrying.
 */
export const WORKER_DEATH_CODES = readonlyCodeSet('WORKER_DEATH_CODES', [
  COMPILER_ERROR_CODES.workerTimeout,
  COMPILER_ERROR_CODES.workerCrashed,
  COMPILER_ERROR_CODES.workerDead,
])

/**
 * @param {unknown} err
 * @returns {boolean} true when retrying on fresh machinery, or falling back to another
 *   compile path, is worth doing — false for compile errors and for programming errors.
 */
export function isInfrastructureError(err) {
  return !!err && typeof err === 'object' && INFRASTRUCTURE_ERROR_CODES.has(/** @type {{ code?: string }} */ (err).code)
}
