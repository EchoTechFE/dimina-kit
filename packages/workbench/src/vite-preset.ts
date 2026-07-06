/**
 * Shared Vite config fragment for bundling the workbench (@codingame/monaco-vscode-api@34).
 *
 * Merge the returned fragment into a host's `defineConfig` so both this package's
 * prebuilt-bundle build (vite.config.ts) and a source consumer (e.g. the web
 * client) bundle monaco/vscode identically:
 *  - vscode/monaco CSS is inlined as strings (it gets injected, not linked).
 *  - the monaco-vscode-api workers + `vscode/localExtensionHost` are pre-bundled.
 *  - workers emit as ES modules; esbuild keeps syntax un-minified (the worker
 *    bootstrap is sensitive to aggressive minification).
 *  - the `@codingame/*` + monaco/vscode deps are deduped to the host's single
 *    copy (a second monaco-vscode-api instance breaks the editor service).
 *  - dev-only static assets the api reaches via `new URL(…, import.meta.url)`
 *    are served from their real package locations.
 *
 * This module is published as built JS (`@dimina-kit/workbench/vite`) so a host's
 * Vite config can import it from Node — it only uses node builtins + `vite` types.
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { UserConfig } from 'vite'

const require = createRequire(import.meta.url)

/**
 * The `@codingame/*` + monaco/vscode deps that MUST resolve to a single copy.
 * Read from this package's own manifest so the list never drifts from the deps
 * that ship. Empty on any read failure (the host can still add its own dedupe).
 */
function workbenchMonacoDeps(): string[] {
  try {
    // dist/vite-preset.js → ../package.json (and src/vite-preset.ts → ../package.json);
    // the manifest always ships alongside dist, so this resolves in both layouts.
    const pkg = require('../package.json') as { dependencies?: Record<string, string> }
    return Object.keys(pkg.dependencies ?? {}).filter(
      (n) => n.startsWith('@codingame/') || n === 'monaco-editor' || n === 'vscode',
    )
  } catch {
    return []
  }
}

/**
 * Virtual specifiers that resolve to the real fs-core worker files. `@dimina-kit/fs-core`
 * only exports `./client` / `./agent-tools` / `./disk-mirror` / `./zip` (its
 * package.json `exports` map has no entry for the raw `*.worker.js` files, and
 * that map is frozen — see the fs-core transplant invariant), so a bare
 * `@dimina-kit/fs-core/src/fs-core.worker.js` import is not resolvable through
 * Node's exports-field algorithm. `resolve.alias` bypasses the exports map
 * entirely (it substitutes the specifier before package resolution runs), so
 * these virtual ids let a host statically `import … from 'virtual:fs-core/core-worker?worker&url'`
 * (the same `?worker&url` idiom as the monaco/vscode workers above) without
 * touching fs-core's own manifest. Resolved via the sibling of the `./client`
 * export (the one path guaranteed to exist), not a hardcoded `src/` join, so a
 * future fs-core layout change only needs the exports map, not this alias.
 *
 * Uses REGEXP `find` entries (not plain string keys) so only the `virtual:…`
 * prefix is substituted and the `?worker&url` query rollup/vite need to detect
 * the worker-asset transform survives onto the replacement path unmodified —
 * a plain string-keyed alias only matches the FULL specifier verbatim, which
 * never matches once a query is appended, and rolldown then fails to resolve
 * the raw `virtual:…?worker&url` string as a real package specifier.
 */
function fsCoreWorkerAliases(): Array<{ find: RegExp; replacement: string }> {
  try {
    const clientEntry = require.resolve('@dimina-kit/fs-core/client')
    const srcDir = dirname(clientEntry)
    return [
      { find: /^virtual:fs-core\/core-worker/, replacement: join(srcDir, 'fs-core.worker.js') },
      { find: /^virtual:fs-core\/query-worker/, replacement: join(srcDir, 'fs-query.worker.js') },
    ]
  } catch {
    // A source consumer without the fs-core dependency (e.g. web-client before
    // it opts in) never imports these virtual ids, so no alias entries is inert.
    return []
  }
}

/**
 * Dev-server plugin: serve the static assets the api reaches via
 * `new URL('…', import.meta.url)` from PRE-BUNDLED deps, whose computed URL
 * otherwise points into `.vite/deps` and 404s in dev.
 *
 *  - `webWorkerExtensionHostIframe.html` — the worker ext-host iframe; if it
 *    404s the iframe loads as `chrome-error://…`, the ext host never starts and
 *    `bootWorkbench` hangs on `getApi()`.
 *  - `onig.wasm` — the oniguruma TextMate engine; if it 404s tokenization fails
 *    and there is no syntax highlighting.
 *
 * Only runs under `configureServer` (dev); the prebuilt-bundle build, where
 * Rollup emits these assets normally, is unaffected.
 */
export function workbenchDevAssetsPlugin(): NonNullable<UserConfig['plugins']>[number] {
  let iframeFile: string | undefined
  let onigFile: string | undefined
  try {
    // `…/package.json` is not in the package's exports map, but its main entry
    // (index.js) IS and sits at the package root — so dirname(entry) === pkg root.
    const extRoot = dirname(require.resolve('@codingame/monaco-vscode-extensions-service-override'))
    iframeFile = join(
      extRoot,
      'vscode/src/vs/workbench/services/extensions/worker/webWorkerExtensionHostIframe.html',
    )
  } catch {
    iframeFile = undefined
  }
  try {
    const tmRoot = dirname(require.resolve('@codingame/monaco-vscode-textmate-service-override'))
    onigFile = join(tmRoot, 'external/vscode-oniguruma/release/onig.wasm')
  } catch {
    onigFile = undefined
  }
  return {
    name: 'workbench-dev-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = (req.url || '').split('?')[0]
        if (iframeFile && pathname.endsWith('/webWorkerExtensionHostIframe.html')) {
          res.setHeader('Content-Type', 'text/html')
          // The iframe must be cross-origin isolated to spawn the SAB worker.
          res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
          res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
          res.end(readFileSync(iframeFile))
          return
        }
        if (onigFile && pathname.endsWith('/onig.wasm')) {
          res.setHeader('Content-Type', 'application/wasm')
          res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
          res.end(readFileSync(onigFile))
          return
        }
        next()
      })
    },
  }
}

/** A Vite plugin that rewrites vscode/monaco CSS imports to `?inline` strings. */
export function workbenchCssInlinePlugin(): NonNullable<UserConfig['plugins']>[number] {
  return {
    name: 'load-vscode-css-as-string',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if ((options as { scan?: boolean }).scan) return undefined
      const resolved = await this.resolve(source, importer, options)
      if (!resolved) return undefined
      if (/node_modules\/(@codingame\/monaco-vscode|vscode|monaco-editor).*\.css$/.test(resolved.id)) {
        return { ...resolved, id: resolved.id + '?inline' }
      }
      return undefined
    },
  }
}

/** Vite config fragment for any host bundling the workbench source. */
export function workbenchVitePreset(): UserConfig {
  return {
    worker: { format: 'es' },
    esbuild: { minifySyntax: false },
    plugins: [workbenchCssInlinePlugin(), workbenchDevAssetsPlugin()],
    resolve: {
      dedupe: workbenchMonacoDeps(),
      alias: fsCoreWorkerAliases(),
    },
    optimizeDeps: {
      include: [
        '@codingame/monaco-vscode-api',
        '@codingame/monaco-vscode-api/extensions',
        'vscode/localExtensionHost',
      ],
      // Leaf default-extension packages stay OUT of pre-bundling so their
      // `new URL('./resources/*.json', import.meta.url)` (themes, grammars, nls)
      // resolves to the real served files instead of a 404 `.vite/deps` path.
      // They only import the api `extensions` entry (no deep vscode/vs subpaths),
      // so serving them as source is safe.
      exclude: [
        '@codingame/monaco-vscode-theme-defaults-default-extension',
        '@codingame/monaco-vscode-json-default-extension',
        '@codingame/monaco-vscode-css-default-extension',
        '@codingame/monaco-vscode-javascript-default-extension',
        '@codingame/monaco-vscode-typescript-basics-default-extension',
        '@codingame/monaco-vscode-typescript-language-features-default-extension',
      ],
    },
  }
}
