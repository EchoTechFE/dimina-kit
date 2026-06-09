/**
 * `DisposableRegistry` now lives in `@dimina-kit/electron-deck/main` — the
 * foundation layer that devtools sits on top of (foundation.md §3, §11
 * decision 1). This module re-exports it so the ~27 existing devtools call
 * sites keep importing from `../utils/disposable.js` unchanged while the
 * primitive itself is owned by the package.
 */
export {
  DisposableRegistry,
  toDisposable,
  type Disposable,
  type DisposeFn,
} from '@dimina-kit/electron-deck/main'
