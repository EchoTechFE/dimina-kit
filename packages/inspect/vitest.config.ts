import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
    globals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'html', 'json-summary'],
      reportsDirectory: './coverage',
      // Uncovered src files count toward the denominator — without an explicit
      // include, vitest only reports files loaded during the run, so a new
      // untested file would not lower the percentage.
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        '**/*.test.{ts,tsx}',
        'dist/**',
        '**/*.config.*',
        '**/*.d.ts',
        // The React panel is exercised by the devtools renderer suite
        // (wxml-panel.test.tsx), which owns the testing-library setup; this
        // package's own suite covers the host-agnostic core.
        'src/panel.tsx',
      ],
    },
  },
})
