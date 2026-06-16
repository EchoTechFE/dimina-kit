import { builtinModules } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const __dirname = dirname(fileURLToPath(import.meta.url))
const src = resolve(__dirname, 'src')

/**
 * Vite library build for `@dimina-kit/electron-deck`.
 *
 * Rollup ESM output (NOT esbuild CJS bundling) so main-process code keeps clean
 * ESM `import` statements — no esbuild CJS-interop dynamic-require shims that
 * break the Electron main process.
 *
 * Externals: `electron` + all node builtins stay external (imported, never
 * inlined). The lazy `import('electron')` in src/electron-deck.ts is preserved
 * as a dynamic import of an external id.
 *
 * `@dimina-kit/view-anchor` is deliberately NOT external → its source is
 * inlined into the `client/index` entry (the only runtime importer), making the
 * package self-contained (no bare `@dimina-kit/*` import survives in dist).
 */
export default defineConfig({
	build: {
		target: 'esnext',
		minify: false,
		sourcemap: true,
		emptyOutDir: true,
		outDir: resolve(__dirname, 'dist'),
		lib: {
			// Keys are the output-relative paths (without extension) so each entry
			// lands exactly where the `exports` map points.
			entry: {
				'index': resolve(src, 'index.ts'),
				'main/index': resolve(src, 'main/index.ts'),
				'preload/index': resolve(src, 'preload/index.ts'),
				'host/index': resolve(src, 'host/index.ts'),
				'client/index': resolve(src, 'client/index.ts'),
				'layout/index': resolve(src, 'layout/index.ts'),
				'dock-react/index': resolve(src, 'dock-react/index.ts'),
			},
			formats: ['es'],
		},
		rollupOptions: {
			// Externalize electron + node builtins + react ecosystem; bundle
			// everything else (including @dimina-kit/view-anchor). React and
			// react-resizable-panels are peer/regular deps the host provides —
			// they must never be inlined into the lib.
			external: (id: string) =>
				id === 'electron'
				|| id === 'react'
				|| id === 'react-dom'
				|| id === 'react/jsx-runtime'
				|| id === 'react-resizable-panels'
				|| id.startsWith('node:')
				|| builtinModules.includes(id),
			output: {
				preserveModules: false,
				entryFileNames: '[name].js',
				chunkFileNames: '[name]-[hash].js',
			},
		},
	},
})
