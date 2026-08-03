import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Vitest's default glob also matches `*.spec.ts`, which collides with the
    // Playwright suite under e2e/ (test.describe() called outside Playwright's
    // own runner throws "did not expect test.describe() to be called here").
    // Scope to this package's own unit-test convention, same as devtools'
    // vitest.config.ts.
    include: ['src/**/*.test.ts'],
  },
})
