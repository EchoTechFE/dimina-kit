import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const rendererRoot = resolve(__dirname, 'src/renderer')

const isWatch = process.argv.includes('--watch')

export default defineConfig({
  root: rendererRoot,
  // Per-entry cache so the renderer and simulator configs don't fight
  // over the same directory and invalidate each other.
  cacheDir: resolve(__dirname, 'node_modules/.vite-cache/renderer'),
  plugins: [react()],
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  css: {
    // PostCSS config is in package root; Vite's root is src/renderer, so we must specify
    postcss: __dirname,
  },
  base: './',
  build: {
    outDir: resolve(__dirname, 'dist/renderer'),
    sourcemap: true,
    // In watch mode, skip emptyOutDir to avoid deleting files while Electron is running.
    // The initial full build (pnpm build) already populates dist/renderer cleanly.
    emptyOutDir: !isWatch,
    rollupOptions: {
      external: ['electron', 'path', 'fs', 'os', 'url', 'child_process'],
      input: {
        index: resolve(rendererRoot, 'entries/main/index.html'),
        popover: resolve(rendererRoot, 'entries/popover/index.html'),
        settings: resolve(rendererRoot, 'entries/settings/index.html'),
        workbenchSettings: resolve(rendererRoot, 'entries/workbench-settings/index.html'),
      },
    },
  },
  resolve: {
    alias: {
      '@': rendererRoot,
    },
  },
})
