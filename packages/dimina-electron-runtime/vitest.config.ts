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
  },
})
