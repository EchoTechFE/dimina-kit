import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // `src/simulator-ui` is JSX; the rest of the package is plain TS.
  plugins: [react()],
  test: {
    // Vitest's default glob also matches `*.spec.ts`, which collides with the
    // Playwright suite under e2e/ (test.describe() called outside Playwright's
    // own runner throws "did not expect test.describe() to be called here").
    // Scope to this package's own unit-test convention, same as devtools'
    // vitest.config.ts.
    include: ['src/**/*.test.{ts,tsx}'],
    // Main-process modules run on Node. The simulator-ui component tests that
    // need a DOM opt in per file with a `@vitest-environment jsdom` docblock.
    environment: 'node',
    // @testing-library/react unmounts each render in an `afterEach` it
    // registers itself, and it only does so when a global `afterEach` exists.
    // Without this a component suite leaves its trees in the document and the
    // next `screen.getBy*` finds several matches instead of one.
    globals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'html', 'json-summary'],
      reportsDirectory: './coverage',
      // Pin the denominator to all of `src/**`, not to whatever the run
      // happened to load. Without this, v8 only counts files an executed test
      // imported, so the first test written for a large module drops the
      // package's coverage by pulling that module and its whole import graph
      // into the denominator at once — the metric would punish adding tests.
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        '**/*.test.{ts,tsx}',
        '**/__test-stubs__/**',
        // Imports vitest and drives the ws contract suites; it ships under
        // src/ but is test scaffolding, not runtime code.
        'src/main/services/native-websocket/contract-harness.ts',
        '**/*.config.*',
        '**/*.d.ts',
      ],
    },
  },
})
