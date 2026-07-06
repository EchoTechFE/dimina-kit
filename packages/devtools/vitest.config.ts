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
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'html', 'json-summary'],
      reportsDirectory: './coverage',
      // Uncovered src files count toward the denominator — without an explicit
      // include, vitest only reports files loaded during the run, so a new
      // untested file would not lower the percentage.
      include: ['src/**/*.{ts,tsx,js,jsx}'],
      exclude: [
        '**/*.test.{ts,tsx}',
        '**/__test-stubs__/**',
        'e2e/**',
        'dist/**',
        'build-*.js',
        // Only the contextBridge entry bundles are unmeasurable glue; the
        // instrumentation/runtime/shared preload logic has unit tests.
        'src/preload/windows/**',
        '**/*.config.*',
        '**/*.d.ts',
        'spike/**',
        '_spike/**',
        'templates/**',
      ],
    },
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
      {
        find: '@dimina/common',
        replacement: resolve(
          __dirname,
          'src/simulator/service-apis/__test-stubs__/dimina-common.ts',
        ),
      },
    ],
  },
})
