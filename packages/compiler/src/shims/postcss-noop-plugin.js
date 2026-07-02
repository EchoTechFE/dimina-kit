// No-op postcss plugin standing in for autoprefixer / cssnano in the browser build.
// Those pull in browserslist/caniuse which need a Node `process` global; the demo
// skips autoprefixing & minification rather than polluting global process
// (which would make sass / esbuild-wasm / the Go wasm runtime mis-detect Node).
function noop() {
  return { postcssPlugin: 'noop-shim', Once() {} }
}
noop.postcss = true
export default noop
