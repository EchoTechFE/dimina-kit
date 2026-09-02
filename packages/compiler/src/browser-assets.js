/**
 * The authoritative statement of this package's browser static-asset contract,
 * for Node-side consumers that copy or serve the browser bundles (a workbench's
 * dev/build server, a `copy-web-compiler` script):
 *
 *   The files listed in COMPILER_BROWSER_ASSETS are single-file ESM bundles
 *   that import nothing at all, sitting side by side in dist/ under exactly
 *   these names.
 *
 * That contract is for the host that loads them BY URL — a static file it
 * serves itself. Nothing in such a host's source references these files (the
 * stage worker is only ever `new Worker(url)`'d, the other two are fetched and
 * imported from a Blob URL), so its bundler never sees them: it copies nothing,
 * rewrites nothing, and the miss surfaces as a 404 at runtime. That host has to
 * copy them byte for byte, under these names, and serve them as they are.
 *
 * A host that instead reaches them through the package — `import
 * { createCompilerPool } from '@dimina-kit/compiler/pool'`, or
 * `new Worker(new URL('@dimina-kit/compiler/stage-worker', import.meta.url))` —
 * hands its bundler a reference it can follow, and needs none of this.
 *
 * build-compiler.js asserts all of it at build time out of esbuild's own
 * metafile: every browser output is classified here (static asset or
 * bundler-only), every static asset really is import-free, and the names here
 * still match what package.json's exports map points at. So renaming or
 * splitting an output without updating this list fails the build, instead of
 * 404-ing in some host months later.
 *
 * Pure string manipulation (no node:path) so the module loads in any runtime,
 * and it ships as both ESM (dist/browser-assets.js) and CJS
 * (dist/browser-assets.cjs — see the exports map's `require` condition, for
 * CommonJS hosts).
 */

/**
 * @typedef {object} CompilerBrowserAsset
 * @property {string} name      File name in dist/, and the name to serve it under.
 * @property {string} loadedBy  How a URL-loading browser host gets it.
 */

/** The browser bundles a host that loads them by URL has to serve as static files. */
export const COMPILER_BROWSER_ASSETS = /** @type {readonly CompilerBrowserAsset[]} */ ([
  {
    name: 'stage-worker.browser.js',
    loadedBy: "new Worker(url, { type: 'module' }) — the URL createCompilerPool's createWorker hands the browser",
  },
  {
    name: 'pool.browser.js',
    loadedBy: 'fetch + Blob-URL import, for hosts that load the pool at runtime instead of bundling `@dimina-kit/compiler/pool`',
  },
  {
    name: 'compile-core.browser.js',
    loadedBy: 'fetch + Blob-URL import, on the single-threaded fallback path (no pool, no stage workers)',
  },
])

/**
 * Browser outputs that are NOT static assets: hosts reach them through their own
 * bundler (`import { installOxc } from '@dimina-kit/compiler/toolchain'`), so
 * copying them next to the assets above only ships a file nobody fetches. Listed
 * here so the build-time check can classify every browser output it produces —
 * a new output that is neither an asset nor bundler-only fails the build.
 */
export const BUNDLER_ONLY_BROWSER_OUTPUTS = /** @type {readonly string[]} */ (['toolchain.browser.js'])

/**
 * Shape esbuild's metafile into the output list {@link checkBrowserAssetContract}
 * takes: sourcemaps dropped, and `name` kept as the path RELATIVE TO dist —
 * `assets/stage-worker.browser.js` must not pass as the dist-root file hosts
 * actually copy, so the directory is part of the name, not stripped from it.
 *
 * Every recorded import is carried through with its kind. The check rejects all
 * of them (see below), so nothing here decides what counts as a violation.
 *
 * @param {{ outputs?: Record<string, { imports?: { path: string, kind: string }[] }> }} metafile
 * @param {string} [outdirPrefix]  the metafile keys' prefix for the output directory;
 *   a key outside it keeps its whole path and is then reported as unclassified.
 * @returns {BrowserOutput[]}
 */
export function browserOutputsFromMetafile(metafile, outdirPrefix = 'dist/') {
  const prefix = outdirPrefix.endsWith('/') ? outdirPrefix : `${outdirPrefix}/`
  return Object.entries(metafile.outputs || {})
    .map(([file, output]) => {
      const key = file.split('\\').join('/')
      return {
        name: key.startsWith(prefix) ? key.slice(prefix.length) : key,
        imports: (output.imports || []).map((entry) => ({ path: entry.path, kind: entry.kind })),
      }
    })
    .filter((output) => !output.name.endsWith('.map'))
}

/**
 * @typedef {object} BrowserOutput
 * @property {string} name  Emitted file, as a path relative to dist.
 * @property {{ path: string, kind: string }[]} [imports]  Everything the output still
 *   references at module level, as esbuild's metafile records it (kind is
 *   `import-statement`, `require-call`, `dynamic-import`, …).
 */

/**
 * Check a browser build's outputs against the contract above. Split out of
 * build-compiler.js so the failure modes it exists to catch can be tested
 * directly (see scripts/test-browser-assets.js) instead of only by breaking a
 * real build.
 *
 * An asset that still imports anything — under any kind — is no longer one
 * self-contained file, so a host copying it alone ships something that 404s or
 * half-loads. `import-statement` is only the most obvious kind: an externalized
 * CommonJS dependency is recorded as `require-call`, and a split chunk pulled in
 * lazily as `dynamic-import`. All of them are rejected. The stage worker's
 * `import(toolchainSetupURL)` is not among them: its specifier is a runtime
 * variable, so esbuild cannot resolve it and records no import for it.
 *
 * @param {BrowserOutput[]} outputs  every non-sourcemap output the browser build emitted
 * @returns {string[]} one line per problem; empty when the contract holds
 */
export function checkBrowserAssetContract(outputs) {
  const assetNames = COMPILER_BROWSER_ASSETS.map((asset) => asset.name)
  const classified = new Set([...assetNames, ...BUNDLER_ONLY_BROWSER_OUTPUTS])
  const emitted = new Set(outputs.map((output) => output.name))
  const problems = []

  for (const name of assetNames) {
    if (!emitted.has(name)) {
      problems.push(`browser-assets.js lists dist/${name}, but the browser build did not emit it`)
    }
  }
  for (const output of outputs) {
    if (!classified.has(output.name)) {
      problems.push(`dist/${output.name} is a new browser output: add it to COMPILER_BROWSER_ASSETS (hosts serve it themselves) or to BUNDLER_ONLY_BROWSER_OUTPUTS (hosts reach it through their own bundler) in src/browser-assets.js`)
      continue
    }
    if (!assetNames.includes(output.name)) continue
    for (const entry of output.imports || []) {
      problems.push(`dist/${output.name} is served as a standalone static file but is not self-contained: it still imports ${entry.path} (${entry.kind})`)
    }
  }
  return problems
}

/** @param {unknown} node @param {string[]} out @returns {string[]} */
function collectExportTargets(node, out) {
  if (typeof node === 'string') { out.push(node); return out }
  if (node && typeof node === 'object') {
    for (const value of Object.values(node)) collectExportTargets(value, out)
  }
  return out
}

/**
 * Cross-check this manifest against the package's own exports map. Both describe
 * the same files under the same names, and a rename that lands in only one of
 * them is silent: the manifest still resolves paths that no longer exist, or
 * `import '@dimina-kit/compiler/pool'` still points at a file the build no longer
 * emits. So every `.browser.js` an export points at must be classified here, and
 * every name classified here must still be some export's target.
 *
 * @param {unknown} exportsMap  the package.json `exports` object
 * @param {string} [distPrefix] how those targets spell the dist directory
 * @returns {string[]} one line per problem; empty when both sides agree
 */
export function checkAssetsAgainstExports(exportsMap, distPrefix = './dist/') {
  const classified = [...COMPILER_BROWSER_ASSETS.map((asset) => asset.name), ...BUNDLER_ONLY_BROWSER_OUTPUTS]
  const targets = new Set(
    collectExportTargets(exportsMap, [])
      .filter((target) => target.endsWith('.browser.js'))
      .map((target) => (target.startsWith(distPrefix) ? target.slice(distPrefix.length) : target)),
  )
  const problems = []
  for (const target of targets) {
    if (!classified.includes(target)) {
      problems.push(`package.json exports point at ${distPrefix}${target}, which src/browser-assets.js does not list — add it to COMPILER_BROWSER_ASSETS or BUNDLER_ONLY_BROWSER_OUTPUTS`)
    }
  }
  for (const name of classified) {
    if (!targets.has(name)) {
      problems.push(`src/browser-assets.js lists ${name}, but no package.json exports entry points at ${distPrefix}${name} — one half of a rename is missing`)
    }
  }
  return problems
}

/**
 * @typedef {object} ResolvedBrowserAssets
 * @property {string} dir      Directory holding all of the assets.
 * @property {string[]} files  Absolute path of each asset, in COMPILER_BROWSER_ASSETS order.
 */

/**
 * Resolve the on-disk asset paths from the resolved path of the `./browser`
 * entry — the one path every consumer can obtain without knowing this layout:
 *
 *   resolveBrowserAssets(require.resolve('@dimina-kit/compiler/browser'))
 *
 * Preserves whichever path separator the input uses (POSIX or Windows), so the
 * result is joinable and copyable as-is on the host platform.
 *
 * @param {string} browserEntryPath
 * @returns {ResolvedBrowserAssets}
 */
export function resolveBrowserAssets(browserEntryPath) {
  const cut = Math.max(browserEntryPath.lastIndexOf('/'), browserEntryPath.lastIndexOf('\\'))
  if (cut < 0) throw new Error(`resolveBrowserAssets: not a path to compile-core.browser.js: ${browserEntryPath}`)
  const sep = browserEntryPath[cut]
  const dir = browserEntryPath.slice(0, cut)
  return { dir, files: COMPILER_BROWSER_ASSETS.map((asset) => dir + sep + asset.name) }
}
