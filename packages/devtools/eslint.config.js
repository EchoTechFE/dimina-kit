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
  // Renderer must funnel every IPC call through `shared/api/ipc-transport`
  // and never reach into the raw preload bridge. The transport file itself
  // is the only legitimate consumer of `window.devtools.ipc`; it disables
  // this rule inline.
  {
    files: ["src/renderer/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "MemberExpression[object.object.name='window'][object.property.name='devtools'][property.name='ipc']",
          message:
            "Use the helpers exported from `@/shared/api/ipc-transport` instead of touching `window.devtools.ipc` directly.",
        },
      ],
    },
  },
];
