/**
 * The authoritative statement of fs-core's worker-artifact distribution
 * contract, for Node-side consumers that copy/serve the worker files
 * (dimina-kit workbench's vite-preset, qdmp-web-workbench's server.cjs):
 *
 *   dist/fs-core.worker.js and dist/fs-query.worker.js are single-file,
 *   self-contained ESM (no import statements) living in the SAME directory
 *   as dist/client.js, under exactly these file names.
 *
 * build-workers.js asserts this at build time; consumers should derive the
 * names/locations from here instead of re-deriving them with hardcoded
 * string joins. Pure string manipulation (no node:path) so the module loads
 * in any runtime and ships as both ESM (dist/worker-files.js) and CJS
 * (dist/worker-files.cjs — see the exports map's `require` condition, for
 * CommonJS hosts like server.cjs).
 */

/** The worker artifacts' literal file names, siblings of `client.js`. */
export const FS_CORE_WORKER_FILES = ['fs-core.worker.js', 'fs-query.worker.js'] as const

export interface ResolvedWorkerFiles {
  /** Directory holding client.js and both worker files. */
  dir: string
  /** Absolute path of each worker file, in {@link FS_CORE_WORKER_FILES} order. */
  files: string[]
}

/**
 * Resolve the on-disk worker file paths from the resolved path of the
 * `./client` entry — the one path every consumer can obtain:
 *
 *   resolveWorkerFiles(require.resolve('@dimina-kit/fs-core/client'))
 *
 * Preserves whichever path separator the input uses (POSIX or Windows), so
 * the result is joinable/copyable as-is on the host platform.
 */
export function resolveWorkerFiles(clientEntryPath: string): ResolvedWorkerFiles {
  const cut = Math.max(clientEntryPath.lastIndexOf('/'), clientEntryPath.lastIndexOf('\\'))
  if (cut < 0) throw new Error(`resolveWorkerFiles: not a path to client.js: ${clientEntryPath}`)
  const sep = clientEntryPath[cut]!
  const dir = clientEntryPath.slice(0, cut)
  return { dir, files: FS_CORE_WORKER_FILES.map((name) => dir + sep + name) }
}
