import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    globals: true,
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
        '**/__checks__/**',
        'e2e/**',
        'dist/**',
        '**/*.config.*',
        '**/*.d.ts',
      ],
    },
  },
})
