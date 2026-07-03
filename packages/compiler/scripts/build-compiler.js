import esbuild from 'esbuild'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const shim = (f) => path.join(root, 'src/shims', f)

// The dart-sass package lives in dimina-kit's `dimina` submodule fe workspace.
// Resolve it from there (instead of a machine-specific absolute path) and force
// its pure-JS browser entry (`sass.default.js`) — NOT the node launcher.
const kitFeRequire = createRequire(path.resolve(root, '../../dimina/fe/package.json'))
const sassBrowserEntry = path.join(path.dirname(kitFeRequire.resolve('sass')), 'sass.default.js')

// Pin the browser CSS pipeline to the SAME autoprefixer the node build / real dmcc
// resolve at runtime. esbuild's bundler resolution would otherwise pick a different
// autoprefixer island (10.5.2, from the dimina fe pnpm store) than node require does
// (10.5.0, worktree-root store); the 10.5.2 one adds stray -ms- prefixes for ie 11,
// diverging from dmcc. Anchor the resolve at the node bundle location so browser and
// node reference use byte-identical autoprefixer + its browserslist/caniuse island.
const nodeRuntimeRequire = createRequire(path.join(root, 'dist/compile-core.node.js'))
const autoprefixerEntry = nodeRuntimeRequire.resolve('autoprefixer')

// mode "node"    -> Layer1: validate orchestration in Node, native esbuild/oxc kept external
// mode "browser" -> bundle everything for the browser (pure-JS + wasm toolchain)
// Passed as argv (cross-platform; `MODE=x node ...` breaks on Windows cmd), env MODE kept as fallback.
const MODE = process.argv[2] || process.env.MODE || 'node'
const USE_WASM = process.env.USE_WASM === '1' || MODE === 'browser'

// Append exports for functions/reset-hooks the compiler defines but does not
// export, without touching the submodule source on disk. The reset hooks clear
// the compiler's module-level caches so a pooled worker realm can compile more
// than once without cross-compile contamination (see resetCompilerState).
const exportAppend = {
  name: 'export-append',
  setup(build) {
    const appends = {
      'logic-compiler.js': '\nexport { writeCompileRes }\nexport function __resetLogicState() { processedModules.clear() }\nexport function __setEnableSourcemap(v) { enableSourcemap = !!v }\n',
      'style-compiler.js': '\nexport function __resetStyleState() { compileRes.clear() }\n',
      'view-compiler.js': '\nexport function __resetViewState() { compileResCache.clear(); wxsModuleRegistry.clear(); wxsFilePathMap.clear() }\n',
      'utils.js': '\nexport function __resetAssets() { for (const k of Object.keys(assetsMap)) delete assetsMap[k] }\n',
    }
    build.onLoad({ filter: /(core[\\/](logic|style|view)-compiler|common[\\/]utils)\.js$/ }, async (args) => {
      const base = path.basename(args.path)
      const src = await readFile(args.path, 'utf8')
      return { contents: src + (appends[base] || ''), loader: 'js' }
    })
  },
}

// In node mode, keep heavy/native deps external (resolved at runtime via NODE_PATH).
// Isolate the oxc swap: in node mode, optionally replace native oxc with wasm
// while keeping native esbuild (so any failure is attributable to oxc only).
const USE_OXC_WASM = process.env.USE_OXC_WASM === '1'

// Keep the CSS pipeline external in the node build: inlining browserslist entangles
// its config lookup with the compiler's INJECTED fs (browserslist would walk the
// memfs project tree instead of the real disk). External keeps browserslist on real
// node fs. NOTE: this makes the node build resolve autoprefixer from the worktree
// root store; to compare against true dmcc, generate the reference with
// NODE_PATH pointed at dimina/fe/node_modules (dmcc's own 10.5.2). See dump-node-ref.
const NODE_EXTERNAL = [
  'esbuild', 'sass', 'less', 'postcss',
  'autoprefixer', 'cssnano', 'cheerio', 'htmlparser2', '@vue/compiler-sfc',
  'magic-string', 'source-map-js', 'postcss-selector-parser',
  ...(USE_OXC_WASM ? ['@oxc-parser/wasm'] : ['oxc-parser', 'oxc-walker']),
]

const common = {
  entryPoints: [path.join(root, 'src/compile-core.js')],
  bundle: true,
  format: 'esm',
  target: ['es2022'],
  plugins: [exportAppend],
  logLevel: 'info',
}

const oxcWasmAlias = USE_OXC_WASM
  ? { 'oxc-parser': shim('oxc-parser.js'), 'oxc-walker': shim('oxc-walker.js') }
  : {}

// compile-core.node.js: the injectable in-memory seam — fs is SHIMMED so the caller
// passes a node:fs replacement (memfs). worker_threads is shimmed (isMainThread=true)
// to skip dmcc's parentPort bootstrap since we drive the exports inline.
const nodeShimAlias = {
  'node:fs': shim('fs.js'),
  'fs': shim('fs.js'),
  'node:worker_threads': shim('worker_threads.js'),
  ...oxcWasmAlias,
}

// pool.node.js / stage-worker.node.js: the resident Node disk pool. fs is NATIVE
// (dmcc writes real disk staging, then publishToDist copies to outputDir) — do NOT
// alias it. worker_threads is STILL shimmed so dmcc's own `if(!isMainThread)` parentPort
// bootstrap stays OFF (otherwise its handler would race ours on the same port); the pool
// and stage worker reach the REAL Worker/parentPort via createRequire (bypasses this alias).
const nodeNativeAlias = {
  'node:worker_threads': shim('worker_threads.js'),
  ...oxcWasmAlias,
}

let opts
if (MODE === 'node') {
  opts = {
    ...common,
    platform: 'node',
    external: NODE_EXTERNAL,
  }
} else {
  const alias = {
    'node:fs': shim('fs.js'),
    'fs': shim('fs.js'),
    'node:fs/promises': shim('fs-promises.js'),
    'fs/promises': shim('fs-promises.js'),
    'node:os': shim('os.js'),
    'os': shim('os.js'),
    'node:process': shim('process.js'),
    'process': shim('process.js'),
    'node:url': shim('url.js'),
    'url': shim('url.js'),
    'node:worker_threads': shim('worker_threads.js'),
    'node:path': 'path-browserify',
    'path': 'path-browserify',
    'node:events': 'events',
    'node:buffer': 'buffer',
    'node:stream': 'stream-browserify',
    'stream': 'stream-browserify',
    'node:util': 'util',
    'node:assert': 'assert',
    'less': shim('less.js'),
    // force the pure-JS (browser) sass entry, not the node launcher
    'sass': sassBrowserEntry,
    // force esbuild-wasm's browser ESM build (not the node build)
    'esbuild-wasm': path.join(root, 'node_modules/esbuild-wasm/esm/browser.js'),
  }
  // CSS pipeline: by default bundle the REAL autoprefixer + cssnano (same versions
  // as the node/dmcc build) so the browser CSS output is byte-identical to dmcc.
  // They pull browserslist + caniuse-lite, which only need process.env (already in
  // the banner) since the compiler passes overrideBrowserslist and skips config
  // lookup. Set REAL_CSS=0 to fall back to the old no-op shims (CSS left un-minified).
  if (process.env.REAL_CSS === '0') {
    alias['autoprefixer'] = shim('postcss-noop-plugin.js')
    alias['cssnano'] = shim('postcss-noop-plugin.js')
  } else {
    // pin autoprefixer to the node/dmcc-resolved copy (see above)
    alias['autoprefixer'] = autoprefixerEntry
  }
  if (USE_WASM) {
    alias['esbuild'] = shim('esbuild-wasm.js')
    alias['oxc-parser'] = shim('oxc-parser.js')
    alias['oxc-walker'] = shim('oxc-walker.js')
  }
  opts = {
    ...common,
    platform: 'browser',
    format: 'esm',
    alias,
    define: {
      'process.env.NODE_ENV': '"production"',
      // some postcss plugins reference __filename/__dirname for source locations;
      // esbuild's browser platform leaves them undefined, so provide stable stubs.
      '__filename': '"/index.js"',
      '__dirname': '"/"',
    },
    // Tiny process shim — env + cwd only. NO process.versions.node, so dart-sass,
    // esbuild-wasm and the Go wasm runtime still detect a browser env; cwd is needed
    // by browserslist (real autoprefixer/cssnano) and is safe to expose.
    banner: {
      js: [
        'globalThis.global ||= globalThis;',
        'globalThis.process ||= { env: {}, cwd: () => "/" };',
        'globalThis.process.cwd ||= () => "/";',
      ].join('\n'),
    },
  }
}

// Browser mode ships three bundles from the same config: the core seams
// (compile-core.browser.js), the package's resident stage worker
// (stage-worker.browser.js, bundles the compiler + memfs), and the light-weight
// orchestrated pool (pool.browser.js). Node mode ships only the core.
const outputs = MODE === 'node'
  ? [
      { in: 'src/compile-core.js', out: 'dist/compile-core.node.js', alias: nodeShimAlias },
      // Resident Node worker_threads disk pool (real fs, dmcc-parity output + sourcemap).
      { in: 'src/pool-node.js', out: 'dist/pool.node.js', alias: nodeNativeAlias },
      { in: 'src/stage-worker-node.js', out: 'dist/stage-worker.node.js', alias: nodeNativeAlias },
    ]
  : [
      { in: 'src/browser-entry.js', out: 'dist/compile-core.browser.js' },
      { in: 'src/stage-worker.js', out: 'dist/stage-worker.browser.js' },
      { in: 'src/pool.js', out: 'dist/pool.browser.js' },
      { in: 'src/toolchain.js', out: 'dist/toolchain.browser.js' },
    ]

for (const o of outputs) {
  const built = {
    ...opts,
    entryPoints: [path.join(root, o.in)],
    outfile: path.join(root, o.out),
    ...(o.alias ? { alias: o.alias } : {}),
  }
  await esbuild.build(built)
  console.log(`✅ built MODE=${MODE} USE_WASM=${USE_WASM ? 1 : 0} -> ${o.out}`)
}
