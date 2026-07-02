// Optional helpers for writing the host's `toolchainSetupURL` module (the ESM the pool's
// stage worker imports to install the two wasm hooks). They package the two fiddly bits
// a downstream would otherwise hand-write:
//
//   1. esbuild-wasm's browser build is usually hosted as a STATIC asset (its Go runtime
//      breaks when bundled). Bundlers (Vite/Webpack/Rollup) refuse to `import()` a file
//      that lives in the static/public dir — so we fetch it and import a Blob URL, which
//      side-steps the bundler module graph. `installEsbuildFromURL` does exactly that.
//   2. Installing the globals the compiler shims delegate to (`__esbuildTransform`,
//      `__oxcParseSync`).
//
// oxc-parser stays a HOST import: only your bundler can resolve `oxc-parser` + fetch its
// wasm, so you pass the already-imported module to `installOxc`.
//
// Typical host toolchain-setup.js (imported by the stage worker at warmup):
//   import { installEsbuildFromURL, installOxc } from '@dimina-kit/compiler/toolchain'
//   installOxc(await import('oxc-parser'))
//   await installEsbuildFromURL('/esbuild-browser.mjs', '/esbuild.wasm')

/**
 * Load esbuild-wasm's browser ESM from a static-asset URL (via a Blob URL, so bundlers
 * don't choke) and install `globalThis.__esbuildTransform`.
 * @param {string} moduleURL  URL of esbuild-wasm's browser ESM (e.g. '/esbuild-browser.mjs')
 * @param {string} wasmURL    URL of esbuild.wasm (e.g. '/esbuild.wasm')
 * @returns {Promise<any>} the initialized esbuild module
 */
export async function installEsbuildFromURL(moduleURL, wasmURL) {
  const code = await fetch(moduleURL).then((r) => {
    if (!r.ok) throw new Error(`[compiler] installEsbuildFromURL: failed to fetch ${moduleURL} (${r.status})`)
    return r.text()
  })
  const blobURL = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }))
  const esbuild = await import(/* @vite-ignore */ blobURL)
  await esbuild.initialize({ wasmURL, worker: true })
  globalThis.__esbuildTransform = (input, options) => esbuild.transform(input, options)
  return esbuild
}

/**
 * Install `globalThis.__oxcParseSync` from an already-imported oxc-parser module.
 * @param {{ parseSync?: Function, default?: { parseSync?: Function } }} oxcModule  `await import('oxc-parser')`
 */
export function installOxc(oxcModule) {
  const parseSync = oxcModule && (oxcModule.parseSync || (oxcModule.default && oxcModule.default.parseSync))
  if (typeof parseSync !== 'function') {
    throw new Error('[compiler] installOxc: expected an oxc-parser module exposing parseSync (pass `await import(\'oxc-parser\')`)')
  }
  globalThis.__oxcParseSync = parseSync
}
