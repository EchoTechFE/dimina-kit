/**
 * Isolated in its own module so the worker URLs are STATIC imports (the
 * pattern this build's asset pipeline actually splits into discrete worker
 * chunks — a dynamic `import('…?worker&url')` inlines the worker source into
 * the importing chunk instead of emitting it separately). wal-audit.ts
 * reaches this module only through a lazy `import()`, so vitest — which
 * cannot resolve the virtual `?worker&url` specifiers outside a real Vite
 * build — never has to transform this file unless the real client is
 * actually constructed (every unit test injects its own `createClient` and
 * never triggers that path).
 */
import coreWorkerUrl from 'virtual:fs-core/core-worker?worker&url'
import queryWorkerUrl from 'virtual:fs-core/query-worker?worker&url'

export { coreWorkerUrl, queryWorkerUrl }
