import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		include: ['src/**/*.test.ts'],
		globals: true,
		testTimeout: 15000,
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
