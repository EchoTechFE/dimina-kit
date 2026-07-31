import { config } from '@dimina-kit/eslint-config/base'

export default [
  { ignores: ['dist/**'] },
  ...config,
  {
    files: ['*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
      },
    },
  },
]
