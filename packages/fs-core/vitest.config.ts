import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'sync/**/*.test.ts'],
    globals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'html', 'json-summary'],
      reportsDirectory: './coverage',
      // Uncovered src files count toward the denominator — without an explicit
      // include, vitest only reports files loaded during the run, so a new
      // untested file would not lower the percentage.
      include: ['src/**/*.{ts,tsx,js,jsx}', 'sync/**/*.{ts,tsx,js,jsx}'],
      exclude: [
        '**/*.test.{ts,tsx}',
        '**/__checks__/**',
        'e2e/**',
        'dist/**',
        '**/*.config.*',
        '**/*.d.ts',
        // Browser-only OPFS code: SyncAccessHandle / Web Locks / dedicated
        // workers do not exist in the Node/jsdom vitest environment, so these
        // files are not executable here at all. Their behavioral coverage
        // lives in the consumers' browser e2e suites (dimina-web-client's
        // fs/kernel batteries and the devtools Electron smoke).
        'src/fs-core.worker.ts',
        'src/fs-query.worker.ts',
        'src/client.ts',
        'src/disk-mirror.ts',
      ],
    },
  },
})
