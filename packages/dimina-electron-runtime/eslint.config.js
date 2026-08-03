import globals from 'globals'
import { config } from '@dimina-kit/eslint-config/base'

export default [
  // e2e/fixtures/ are mini-app source fixtures (wx/Page/getApp globals, same
  // pattern as devtools' own eslint.config.js) — not real package code.
  // playwright-report/ and test-results/ are `test:e2e` run artifacts (HTML
  // report, traces, screenshots) — same ignores devtools' own eslint.config.js
  // already has for the same reason.
  { ignores: ['dist/**', 'e2e/fixtures/**', 'playwright-report/**', 'test-results/**'] },
  ...config,
  {
    files: ['*.mjs', 'e2e/**/*.{js,cjs,mjs,ts}'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    // test-preload.cjs is a hand-written CommonJS preload loaded by Electron
    // at runtime by path (never transpiled), same pattern as devtools' own
    // src/**/*.cjs preloads — it legitimately uses `require` in a Node CJS
    // scope while also touching browser globals (it runs in a renderer).
    files: ['e2e/**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        ...globals.browser,
        require: 'readonly',
        module: 'writable',
        exports: 'writable',
      },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
]
