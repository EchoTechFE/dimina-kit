/**
 * Every error a pool rejects with carries `err.code`, and this is the whole set of
 * values. Hosts branch on it: an infrastructure failure is worth retrying on a fresh
 * worker or falling back to another compile path, a compile error must be shown to
 * the user as-is. Without a code the only way to tell those apart is matching the
 * error message text, which silently stops working the moment a message is reworded
 * — including messages that come from the browser, not from this package (a failed
 * dynamic import, an aborted wasm fetch).
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
  /** The pool was disposed; nothing will be compiled on it again. */
  poolDisposed: 'compiler-pool-disposed',
})

/**
 * Failures of the machinery rather than of the project: a fresh worker, or a different
 * compile path, has a real chance of succeeding. `compiler-stage-error` is deliberately
 * absent — re-running a broken project just hides the diagnostic the user needs.
 */
export const INFRASTRUCTURE_ERROR_CODES = Object.freeze(new Set([
  COMPILER_ERROR_CODES.toolchainSetupFailed,
  COMPILER_ERROR_CODES.toolchainDead,
  COMPILER_ERROR_CODES.workerTimeout,
  COMPILER_ERROR_CODES.workerCrashed,
  COMPILER_ERROR_CODES.workerDead,
]))

/**
 * The pool's own retry predicate: these mean the worker is gone, so replaying the whole
 * attempt on a respawned one is safe. Narrower than {@link INFRASTRUCTURE_ERROR_CODES},
 * which also covers failures a *host* may want to react to without the pool retrying.
 */
export const WORKER_DEATH_CODES = Object.freeze(new Set([
  COMPILER_ERROR_CODES.workerTimeout,
  COMPILER_ERROR_CODES.workerCrashed,
  COMPILER_ERROR_CODES.workerDead,
]))

/**
 * @param {unknown} err
 * @returns {boolean} true when retrying on fresh machinery, or falling back to another
 *   compile path, is worth doing — false for compile errors and for programming errors.
 */
export function isInfrastructureError(err) {
  return !!err && typeof err === 'object' && INFRASTRUCTURE_ERROR_CODES.has(/** @type {{ code?: string }} */ (err).code)
}
