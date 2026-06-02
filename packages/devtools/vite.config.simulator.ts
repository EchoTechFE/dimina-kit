import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const simulatorRoot = resolve(__dirname, 'src/simulator')

const isWatch = process.argv.includes('--watch')

export default defineConfig({
  root: simulatorRoot,
  cacheDir: resolve(__dirname, 'node_modules/.vite-cache/simulator'),
  plugins: [react()],
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
