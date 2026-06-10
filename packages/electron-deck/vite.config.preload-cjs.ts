import { builtinModules } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const __dirname = dirname(fileURLToPath(import.meta.url))
const src = resolve(__dirname, 'src')

/**
 * Secondary build that re-emits ONLY the `./preload` entry as CommonJS
 * (`dist/preload/index.cjs`), on top of the ESM artifacts produced by
 * `vite.config.ts`.
 *
 * Why: Electron's default sandboxed preload loader resolves preload scripts as
 * CJS. With `package.json` `"type": "module"`, a `.js` preload is parsed as ESM
 * and throws `SyntaxError: Cannot use import statement outside a module`, so the
 * bridge never gets exposed. The `./preload` export's `default` therefore points
 * at this `.cjs` artifact (types stay on the ESM `.d.ts`).
 *
 * `emptyOutDir: false` so this does not wipe the primary ESM output. Preload
 * only imports `electron` (external) plus const values from `shared/protocol`;
 * those are inlined into the self-contained CJS bundle.
 */
export default defineConfig({
	build: {
		target: 'esnext',
		minify: false,
		sourcemap: true,
		emptyOutDir: false,
		outDir: resolve(__dirname, 'dist'),
		lib: {
			entry: {
				'preload/index': resolve(src, 'preload/index.ts'),
			},
			formats: ['cjs'],
		},
		rollupOptions: {
			external: (id: string) =>
				id === 'electron'
				|| id.startsWith('node:')
				|| builtinModules.includes(id),
			output: {
				preserveModules: false,
				entryFileNames: '[name].cjs',
				chunkFileNames: '[name]-[hash].cjs',
			},
		},
	},
})
