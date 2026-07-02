// Replacement for `esbuild` (native). esbuild-wasm is NOT bundled here — bundling
// its embedded Go runtime corrupts it (the bundler renames its internal `globalThis`
// shadow). Instead the host worker loads esbuild-wasm as a pristine module and
// installs `globalThis.__esbuildTransform`; we just delegate to it.

export function initEsbuild() {
  // no-op: the host worker initializes esbuild-wasm and sets the hook
  return Promise.resolve()
}

export async function transform(input, options) {
  const fn = globalThis.__esbuildTransform
  if (!fn) {
    throw new Error('[esbuild] globalThis.__esbuildTransform not installed by host')
  }
  return fn(input, options)
}

export default { transform, initEsbuild }
