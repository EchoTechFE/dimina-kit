// Test-only toolchainSetupURL: installs globalThis.__esbuildTransform /
// __oxcParseSync from the NATIVE esbuild/oxc-parser already in this package's own
// dependencies (see package.json), instead of the real esbuild-wasm/oxc wasm32-wasi
// bindings a real browser host would fetch. Both native functions have the exact
// signature the browser shims (src/shims/esbuild-wasm.js / oxc-parser.js) forward
// to verbatim (transform(input,options) / parseSync(filename,code,opts)), so this
// exercises the REAL dist/stage-worker.browser.js code path end-to-end in Node
// without paying for a wasm toolchain load.
import { transform } from 'esbuild'
import { parseSync } from 'oxc-parser'

globalThis.__esbuildTransform = (input, options) => transform(input, options)
globalThis.__oxcParseSync = parseSync
