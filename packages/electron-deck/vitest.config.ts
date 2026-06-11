import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		include: ['src/**/*.test.ts'],
		globals: true,
		testTimeout: 15000,
	},
})
