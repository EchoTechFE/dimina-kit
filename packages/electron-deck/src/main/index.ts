/**
 * `@dimina-kit/electron-deck/main` — main-process foundation primitives.
 *
 * The connection layer (foundation.md §4): one `Connection` per trusted
 * webContents, owning a single `DisposableRegistry` lifetime segment that tears
 * down deterministically on hard-destroy or soft-reuse. devtools (and other
 * downstream hosts) consume this as the substrate for connection-scoped resource ownership.
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
export { createScope, type Scope } from './scope.js'
export {
  createCompositor,
  CommitError,
  type Compositor,
  type ContentViewHost,
  type NativeViewRef,
} from './compositor.js'
export {
  createViewHandle,
  type ViewHandle,
  type ViewHandleDeps,
  type NativeView,
  type PlaceTarget,
  type Placement,
  type Bounds,
} from './view-handle.js'
export { createLogger, setLogLevel, type Logger } from './logger.js'
export {
  createDebugTap,
  type DebugTap,
  type DebugTapEntry,
  type DebugTapOptions,
} from './debug-tap.js'
