/**
 * `@dimina-kit/workbench/main` — main-process foundation primitives.
 *
 * The connection layer (foundation.md §4): one `Connection` per trusted
 * webContents, owning a single `DisposableRegistry` lifetime segment that tears
 * down deterministically on hard-destroy or soft-reuse. devtools (and qdmp)
 * consume this as the substrate for connection-scoped resource ownership.
 */
export {
  createConnectionRegistry,
  type Connection,
  type ConnectionRegistry,
} from './connection.js'
export {
  DisposableRegistry,
  toDisposable,
  type Disposable,
  type DisposeFn,
} from './disposable.js'
export { createLogger, setLogLevel, type Logger } from './logger.js'
export {
  createDebugTap,
  type DebugTap,
  type DebugTapEntry,
  type DebugTapOptions,
} from './debug-tap.js'
