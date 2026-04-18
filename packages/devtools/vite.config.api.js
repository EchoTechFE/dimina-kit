/**
 * Standalone vite config for building src/runtime.js as an ES module library.
 *
 * Produces dist/assets/container-api.js.
 *
 * The main container build (index + pageFrame HTML entries) runs first with the
 * upstream vite.config.mjs. This second build appends the browser API bundle into
 * the same dist/ directory (emptyOutDir: false).
 */
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

// This config is invoked with cwd = container source root
const containerRoot = process.cwd()

/**
 * Vite plugin that resolves `@dimina/service?url` to the external asset URL
 * produced by the main container build, instead of letting Vite inline the
 * entire service bundle as a base64 data-URL.  Data-URL Workers have an
 * opaque origin so `importScripts('/…')` fails; using the real URL avoids
 * that problem.
 */
/**
 * Vite plugin that resolves `@dimina/service?url` to the external asset URL
 * produced by the main container build, instead of letting Vite inline the
 * entire service bundle as a base64 data-URL.  Data-URL Workers have an
 * opaque origin so `importScripts('/…')` fails; using the real URL avoids
 * that problem.
 */
function externalServiceUrl() {
	const SERVICE_ID = '\0external-service-url'
	return {
		name: 'external-service-url',
		enforce: 'pre',
		resolveId(source) {
			// Match both '@dimina/service?url' and the resolved path with ?url suffix
			if (source === '@dimina/service?url' || (source.includes('service') && source.endsWith('?url'))) {
				return SERVICE_ID
			}
		},
		load(id) {
			if (id === SERVICE_ID) return 'export default "/assets/service.js"'
		},
	}
}

export default defineConfig({
	root: containerRoot,
	base: '/',
	plugins: [externalServiceUrl()],
	resolve: {
		extensions: ['.js', '.scss'],
		alias: {
			'@': resolve(containerRoot, 'src'),
			'@images': '/images',
		},
	},
	css: {
		preprocessorOptions: {
			scss: {
				additionalData: `@use "@/styles/funcs" as *;`,
			},
		},
	},
	build: {
		emptyOutDir: false,
		minify: 'terser',
		terserOptions: {
			compress: {
				drop_console: true,
				drop_debugger: true,
				keep_fargs: false,
				reduce_vars: true,
				booleans: true,
			},
			format: { comments: false },
		},
		lib: {
			entry: resolve(containerRoot, 'src/runtime.js'),
			formats: ['es'],
			fileName: () => 'assets/container-api.js',
		},
		rollupOptions: {
			output: {
				assetFileNames: 'assets/[name][extname]',
			},
		},
	},
})
