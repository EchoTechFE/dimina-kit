import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Separate config for the React `dock-react` suite. The default vitest.config.ts
// runs the PURE-TS layout suite under node (no jsdom, .test.ts only). These two
// configs are intentionally disjoint so the layout core stays react/electron-free.
export default defineConfig({
	plugins: [react()],
	test: {
		environment: 'jsdom',
		include: ['src/dock-react/**/*.test.tsx'],
		// react-resizable-panels uses ResizeObserver in its mount effect; jsdom
		// has none. The setup file polyfills it (test infra only).
		setupFiles: ['./src/dock-react/_test-setup.ts'],
		globals: true,
		testTimeout: 15000,
	},
})
