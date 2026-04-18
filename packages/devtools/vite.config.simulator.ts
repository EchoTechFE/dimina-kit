import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const simulatorRoot = resolve(__dirname, 'src/simulator')

const isWatch = process.argv.includes('--watch')

/**
 * Redirect the `container-api` module alias to the runtime URL
 * `/assets/container-api.js` and mark it external so Rollup does not
 * attempt to bundle it.  The asset is built and served by a separate
 * pipeline (@dimina-kit/devkit / vite.config.api.js).
 */
function externalContainerAssets(): Plugin {
  return {
    name: 'external-container-assets',
    enforce: 'pre',
    resolveId(id) {
      if (id === 'container-api') {
        return { id: '/assets/container-api.mjs', external: true }
      }
      if (id.startsWith('/assets/')) {
        return { id, external: true }
      }
    },
  }
}

export default defineConfig({
  root: simulatorRoot,
  plugins: [react(), externalContainerAssets()],
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  // Simulator HTML is served at the root path /simulator.html by the express
  // server; assets are served under /simulator/* via express.static.
  // Setting base to /simulator/ ensures generated asset paths match.
  base: '/simulator/',
  build: {
    outDir: resolve(__dirname, 'dist/simulator'),
    sourcemap: true,
    emptyOutDir: !isWatch,
    rollupOptions: {
      input: {
        simulator: resolve(simulatorRoot, 'simulator.html'),
      },
    },
  },
})
