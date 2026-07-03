// ESM resolve hook: resolve bare external specifiers from dimina-kit's node_modules
// (Layer 1 node test only; the browser bundle inlines everything).
import { createRequire, isBuiltin } from 'node:module'
import { pathToFileURL } from 'node:url'

// Resolve bare deps from the dimina-kit workspace root node_modules relative to
// this file, not a machine-specific path.
const kitRequire = createRequire(new URL('../../../package.json', import.meta.url))

function isBare(spec) {
  return !spec.startsWith('.') && !spec.startsWith('/')
    && !spec.startsWith('node:') && !spec.includes('://')
    && !isBuiltin(spec)
}

export async function resolve(specifier, context, next) {
  if (isBare(specifier)) {
    // Try normal resolution FIRST so packages reachable from the importer (e.g. memfs
    // and its CJS deps) load with their own correct versions and CJS/ESM interop. Only
    // when the default can't find a bare dep — the compiler's externals
    // (sass/less/oxc/esbuild…) that live in the kit workspace root, not next to this
    // bundle — fall back to kit-root resolution.
    try {
      return await next(specifier, context)
    } catch {
      try {
        const p = kitRequire.resolve(specifier)
        return { url: pathToFileURL(p).href, shortCircuit: true }
      } catch {
        // fall through to the default's own error below
      }
    }
  }
  return next(specifier, context)
}
