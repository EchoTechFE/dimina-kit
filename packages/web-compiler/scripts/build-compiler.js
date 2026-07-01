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

// MODE=node  -> Layer1: validate orchestration in Node, native esbuild/oxc kept external
// MODE=browser -> bundle everything for the browser (pure-JS + wasm toolchain)
const MODE = process.env.MODE || 'node'
const USE_WASM = process.env.USE_WASM === '1' || MODE === 'browser'

// Append exports for functions the compiler defines but does not export,
// without touching the submodule source on disk.
const exportAppend = {
  name: 'export-append',
  setup(build) {
    const appends = {
      'logic-compiler.js': '\nexport { writeCompileRes }\n',
    }
    build.onLoad({ filter: /core[\\/]logic-compiler\.js$/ }, async (args) => {
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

let opts
if (MODE === 'node') {
  opts = {
    ...common,
    platform: 'node',
    outfile: path.join(root, 'dist/compile-core.node.js'),
    alias: {
      'node:fs': shim('fs.js'),
      'fs': shim('fs.js'),
      'node:worker_threads': shim('worker_threads.js'),
      ...(USE_OXC_WASM ? {
        'oxc-parser': shim('oxc-parser.js'),
        'oxc-walker': shim('oxc-walker.js'),
      } : {}),
    },
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
    // no-op the browserslist-dependent postcss plugins (avoids needing global process)
    'autoprefixer': shim('postcss-noop-plugin.js'),
    'cssnano': shim('postcss-noop-plugin.js'),
  }
  if (USE_WASM) {
    alias['esbuild'] = shim('esbuild-wasm.js')
    alias['oxc-parser'] = shim('oxc-parser.js')
    alias['oxc-walker'] = shim('oxc-walker.js')
  }
  opts = {
    ...common,
    entryPoints: [path.join(root, 'src/browser-entry.js')],
    platform: 'browser',
    format: 'esm',
    outfile: path.join(root, 'dist/compile-core.browser.js'),
    alias,
    define: { 'process.env.NODE_ENV': '"production"' },
    // Only a tiny process.env shim — NO global process object, so dart-sass,
    // esbuild-wasm and the Go wasm runtime all correctly detect a browser env.
    banner: {
      js: [
        'globalThis.global ||= globalThis;',
        'globalThis.process ||= { env: {} };',
      ].join('\n'),
    },
  }
}

await esbuild.build(opts)
console.log(`\n✅ built MODE=${MODE} USE_WASM=${USE_WASM ? 1 : 0} -> ${path.relative(root, opts.outfile)}`)
