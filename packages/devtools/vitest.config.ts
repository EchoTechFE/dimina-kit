import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const rendererRoot = resolve(__dirname, 'src/renderer')

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    globals: true,
    setupFiles: ['./src/renderer/test-setup.ts'],
  },
  resolve: {
    alias: [
      { find: '@', replacement: rendererRoot },
      // `service-apis/audio/index.js` imports `../../../common`, a module
      // that only exists inside the dimina submodule at runtime. Map it to a
      // test-only stub so the audio event-bridge unit test can load it.
      {
        find: /^\.\.\/\.\.\/\.\.\/common$/,
        replacement: resolve(
          __dirname,
          'src/simulator/service-apis/audio/__test-stubs__/common.ts',
        ),
      },
    ],
  },
})
