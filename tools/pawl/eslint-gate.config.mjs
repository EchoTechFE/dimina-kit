import sonarjs from 'eslint-plugin-sonarjs'
import tseslint from 'typescript-eslint'

export default [
  {
    ignores: [
      '**/*.test.{ts,tsx}',
      '**/*.spec.{ts,tsx}',
      '**/*.d.ts',
      '**/dist/**',
    ],
  },
  {
    files: ['packages/*/src/**/*.ts', 'packages/*/src/**/*.tsx'],
    linterOptions: {
      // The gate measures the real debt surface; an inline suppression must not
      // make an offender disappear from the baseline.
      noInlineConfig: true,
    },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      sonarjs,
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': 'error',
      'sonarjs/cognitive-complexity': ['error', 15],
    },
  },
]
