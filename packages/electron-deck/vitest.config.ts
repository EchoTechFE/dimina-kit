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
			// Uncovered src files count toward the denominator — without an explicit
			// include, vitest only reports files loaded during the run, so a new
			// untested file would not lower the percentage. dock-react is excluded
			// here because its own suite (vitest.dock-react.config.ts) owns those
			// files — the two suites' denominators stay disjoint.
			include: ['src/**/*.{ts,tsx,js,jsx}'],
			exclude: [
				'src/dock-react/**',
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
