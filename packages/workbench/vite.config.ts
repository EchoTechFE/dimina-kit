/// <reference types="vitest/config" />
import { defineConfig, mergeConfig } from 'vite'
import { workbenchVitePreset } from './src/vite-preset'

/**
 * Prebuilt static-bundle build for the VS Code workbench (entry: src/main.ts via
 * index.html). The monaco/vscode bundling rules live in `workbenchVitePreset` so
 * a source consumer (the web client) bundles identically.
 *
 * The output dir is overridable so the devtools `build:workbench` target can emit
 * the bundle straight into the product dist (dist/vscode-workbench). base stays
 * './' so the bundle is origin-root agnostic (the in-product COI server serves
 * it at root). The standalone default is
 * `dist-app` so it never collides with the published library dist (`dist/`).
 */
export default defineConfig(
  mergeConfig(workbenchVitePreset(), {
    root: __dirname,
    base: './',
    build: {
      target: 'esnext',
      outDir: process.env.WORKBENCH_OUT_DIR || 'dist-app',
      emptyOutDir: true,
      chunkSizeWarningLimit: 50_000,
    },
    test: {
      coverage: {
        provider: 'v8',
        reporter: ['text', 'text-summary', 'html', 'json-summary'],
        reportsDirectory: './coverage',
        // Uncovered src files count toward the denominator — without an explicit
        // include, vitest only reports files loaded during the run, so a new
        // untested file would not lower the percentage.
        include: ['src/**/*.{ts,tsx,js,jsx}'],
        exclude: ['**/*.test.{ts,tsx}', '**/*.d.ts', '**/__test-stubs__/**'],
      },
    },
  }),
)
