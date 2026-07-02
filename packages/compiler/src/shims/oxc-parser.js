// oxc-parser replacement. The browser-capable wasm build is oxc-parser's OWN
// official wasm32-wasi binding (version-matched, maintained) — loaded by the host
// worker (it has top-level await + a relative wasm fetch + WASI worker, so it
// can't be inlined into this bundle). The host installs globalThis.__oxcParseSync;
// the wasm `parseSync(filename, sourceText, options)` signature matches native, so
// we forward verbatim — no adaptation, identical AST.

export function parseSync(filename, code, opts) {
  const fn = globalThis.__oxcParseSync
  if (!fn) {
    throw new Error('[oxc] globalThis.__oxcParseSync not installed by host')
  }
  return fn(filename, code, opts)
}

// kept for API compatibility; the host worker initializes the wasm directly.
export function initOxc() {
  return Promise.resolve()
}

export default { parseSync, initOxc }
