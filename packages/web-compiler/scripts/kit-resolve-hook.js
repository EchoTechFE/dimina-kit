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
    try {
      const p = kitRequire.resolve(specifier)
      return { url: pathToFileURL(p).href, shortCircuit: true }
    } catch {
      // fall through to default
    }
  }
  return next(specifier, context)
}
