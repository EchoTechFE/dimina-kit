import globals from "globals";
import { config } from "@dimina-kit/eslint-config/react-internal";

/** @type {import("eslint").Linter.Config[]} */
export default [
  ...config,
  {
    ignores: ["container/**", "docs/**"],
  },
  {
    files: [
      "*.config.{js,cjs,mjs,ts}",
      "vite.config.*.{js,cjs,mjs,ts}",
      "build-container.js",
      "e2e/**/*.{js,cjs,mjs,ts}",
      "src/main/**/*.ts",
      "src/preload/**/*.ts",
      "src/shared/**/*.ts",
      "src/simulator/**/*.ts",
    ],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    files: ["e2e/**/*.{ts,js}"],
    rules: {
      "react-hooks/rules-of-hooks": "off",
    },
  },
];
