// Bundle the dockable-demo renderer React app into a single browser IIFE.
// React + react-dom + the consumed dist (layout / dock-react / client) are all
// inlined so index.html can load one <script src="./app.bundle.js">.
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))

await build({
	entryPoints: [join(HERE, 'app.src.jsx')],
	outfile: join(HERE, 'app.bundle.js'),
	bundle: true,
	format: 'iife',
	platform: 'browser',
	target: 'chrome120',
	jsx: 'automatic',
	loader: { '.js': 'jsx' },
	define: { 'process.env.NODE_ENV': '"production"' },
	logLevel: 'info',
})

console.log('[bundle] wrote app.bundle.js')
