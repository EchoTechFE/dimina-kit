import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    globals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'html', 'json-summary'],
      reportsDirectory: './coverage',
      exclude: [
        '**/*.test.{ts,tsx}',
        '**/__test-stubs__/**',
        'e2e/**',
        'dist/**',
        '**/*.config.*',
        '**/*.d.ts',
      ],
    },
  },
})
