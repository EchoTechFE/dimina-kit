import { config } from "@dimina-kit/eslint-config/base";
import globals from "globals";

export default [
  ...config,
  {
    // Runs inside render-layer documents (injected script / preview iframe)
    // and in React panel hosts — browser globals only, no Node.
    files: ["src/**/*.ts", "src/**/*.tsx"],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
  },
  {
    ignores: ["coverage/**", "dist/**"],
  },
];
