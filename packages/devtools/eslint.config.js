import globals from "globals";
import { config } from "@dimina-kit/eslint-config/react-internal";

/** @type {import("eslint").Linter.Config[]} */
export default [
  ...config,
  {
    // templates/ are scaffolds copied verbatim into user projects (with wx/App/Page
    // globals + Taro-compiled minified bundles); playwright-report and test-results
    // are e2e artifacts. None of these are source we maintain — skip linting them.
    ignores: ["container/**", "docs/**", "templates/**", "playwright-report/**", "test-results/**"],
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
  {
    // Hand-written CommonJS preloads + their pure `.cjs` siblings are loaded by
    // Electron at runtime by path and copied verbatim by build-native-host.mjs
    // (never transpiled), so they legitimately use `require`/`module` in a Node
    // CJS scope while also touching browser globals (they run in a renderer).
    // Provide only the CJS module globals (not all of `globals.node`, which
    // would shadow browser globals like `reportError` the preloads define) and
    // allow the CJS module syntax.
    files: ["src/**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      globals: {
        ...globals.browser,
        require: "readonly",
        module: "writable",
        exports: "writable",
        __dirname: "readonly",
        __filename: "readonly",
        process: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
      // The preloads define helper functions (e.g. `reportError`) that collide
      // with seldom-used browser built-ins of the same name; the local binding
      // is intentional, so don't flag the shadow in these hand-written files.
      "no-redeclare": "off",
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
