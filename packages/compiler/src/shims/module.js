// node:module shim for the browser build.
//
// cssnano 9.x builds its own `require` via createRequire(import.meta.url) so it
// can dynamically load a user-supplied preset/plugin/configFile given as a
// string (see cssnano's `require(pluginDef)` calls). Kit's browser pipeline
// always calls cssnano() with no options — the fixed default preset — so that
// require is constructed but never invoked. Match esbuild's own "dynamic
// require of X is not supported" runtime stub instead of silently returning
// a real loader: any future caller that DOES pass a custom preset/plugin
// string fails loudly at the call site instead of pulling in a fake resolver.
export function createRequire() {
  return function shimmedRequire(id) {
    throw new Error(`Dynamic require of "${id}" is not supported in the browser compiler build`)
  }
}

export default { createRequire }
