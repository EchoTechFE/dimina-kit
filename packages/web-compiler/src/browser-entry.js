// Browser entry: bundles the in-memory dmcc compiler for the browser.
// The wasm toolchain is NOT bundled here — the host worker loads it and installs
// globalThis.__esbuildTransform + globalThis.__oxcParseSync (both have relative
// wasm assets / nested workers that can't survive being inlined into one bundle).
// `esbuild` -> src/shims/esbuild-wasm.js, `oxc-parser` -> src/shims/oxc-parser.js.
//
// This bundle carries NO fs implementation: the host injects its own node:fs
// replacement (memfs, or anything meeting the contract) via compileMiniApp({ fs }).
import { compileMiniApp } from './compile-core.js'

export { compileMiniApp }

/**
 * Kept for API stability. The host worker injects the wasm toolchain hooks
 * before calling compileMiniApp, so there is nothing to initialize here.
 */
export async function initToolchain() {}
