/**
 * The authoritative statement of this package's browser static-asset contract,
 * for Node-side consumers that copy or serve the browser bundles (a workbench's
 * dev/build server, a `copy-web-compiler` script):
 *
 *   The files listed in COMPILER_BROWSER_ASSETS are single-file ESM bundles
 *   with no static imports, sitting side by side in dist/ under exactly these
 *   names. Hosts must serve them RAW — running them through a bundler again
 *   breaks them, and nothing forces the host to notice: the stage worker is
 *   only ever `new Worker(url)`'d and the other two are only ever fetched and
 *   imported from a Blob URL, so no bundler ever sees the reference and
 *   rewrites it.
 *
 * build-compiler.js asserts both halves at build time out of esbuild's own
 * metafile: every browser output is classified here (static asset or
 * bundler-only), and every static asset really has zero static imports. So
 * renaming or splitting an output without updating this list fails the build,
 * instead of 404-ing in some host months later.
 *
 * Pure string manipulation (no node:path) so the module loads in any runtime,
 * and it ships as both ESM (dist/browser-assets.js) and CJS
 * (dist/browser-assets.cjs — see the exports map's `require` condition, for
 * CommonJS hosts).
 */

/**
 * @typedef {object} CompilerBrowserAsset
 * @property {string} name      File name in dist/, and the name to serve it under.
 * @property {string} loadedBy  How the browser gets it — why it must stay raw.
 */

/** The browser bundles a host has to host as static assets. */
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
 * takes: sourcemaps dropped, and only `import-statement` imports kept. Dynamic
 * imports are deliberately ignored — the stage worker reaches the host's toolchain
 * setup module through `import(toolchainSetupURL)` at runtime, which is the
 * contract, not a violation of it.
 *
 * @param {{ outputs?: Record<string, { imports?: { path: string, kind: string }[] }> }} metafile
 * @returns {BrowserOutput[]}
 */
export function browserOutputsFromMetafile(metafile) {
  return Object.entries(metafile.outputs || {})
    .map(([file, output]) => {
      const cut = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'))
      return {
        name: cut < 0 ? file : file.slice(cut + 1),
        staticImports: (output.imports || [])
          .filter((entry) => entry.kind === 'import-statement')
          .map((entry) => entry.path),
      }
    })
    .filter((output) => !output.name.endsWith('.map'))
}

/**
 * @typedef {object} BrowserOutput
 * @property {string} name             Emitted file name, without directories.
 * @property {string[]} [staticImports] Modules the output still imports with an `import … from` statement.
 */

/**
 * Check a browser build's outputs against the contract above. Split out of
 * build-compiler.js so the failure modes it exists to catch can be tested
 * directly (see scripts/test-browser-assets.js) instead of only by breaking a
 * real build.
 *
 * Dynamic imports are fine — the stage worker imports the host's toolchain setup
 * module by URL at runtime. A STATIC import means the output is no longer one
 * self-contained file, so a host copying it alone ships a broken asset.
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
      problems.push(`dist/${output.name} is a new browser output: add it to COMPILER_BROWSER_ASSETS (hosts must serve it) or to BUNDLER_ONLY_BROWSER_OUTPUTS (hosts reach it through their own bundler) in src/browser-assets.js`)
      continue
    }
    if (!assetNames.includes(output.name)) continue
    const staticImports = output.staticImports || []
    if (staticImports.length > 0) {
      problems.push(`dist/${output.name} is served raw as a static asset but statically imports ${staticImports.join(', ')}`)
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
