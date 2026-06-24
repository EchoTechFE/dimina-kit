import { defineConfig } from 'vite'

/**
 * Standalone build for the A2 workbench spike. Its deps live in the devtools
 * package (devDependencies); vite (root=this dir) resolves them upward through
 * node into packages/devtools/node_modules, so no per-spike install is needed.
 * Output served by coi-server.mjs with COOP/COEP for isolation.
 */
// The output dir is overridable so the devtools `build:a2` target can emit the
// workbench bundle straight into the product dist (dist/workbench-a2) instead of
// the spike-local dist/. base stays './' so the bundle is origin-root agnostic
// (the spike coi-server and the in-product COI server both serve it at root).
export default defineConfig({
  root: __dirname,
  base: './',
  build: {
    target: 'esnext',
    outDir: process.env.A2_OUT_DIR || 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 50_000,
  },
  worker: { format: 'es' },
  esbuild: { minifySyntax: false },
  plugins: [
    {
      // vscode/monaco CSS must be inlined as strings so it can be injected.
      name: 'load-vscode-css-as-string',
      enforce: 'pre',
      async resolveId(source, importer, options) {
        if (options.scan) return undefined
        const resolved = await this.resolve(source, importer, options)
        if (!resolved) return undefined
        if (/node_modules\/(@codingame\/monaco-vscode|vscode|monaco-editor).*\.css$/.test(resolved.id)) {
          return { ...resolved, id: resolved.id + '?inline' }
        }
        return undefined
      },
    },
  ],
  optimizeDeps: {
    include: [
      '@codingame/monaco-vscode-api',
      '@codingame/monaco-vscode-api/extensions',
      'vscode/localExtensionHost',
    ],
  },
})
