import { config } from "@dimina-kit/eslint-config/base";
import globals from "globals";

/** @type {import("eslint").Linter.Config[]} */
export default [
  ...config,
  {
    // Ported TCB source (byte-identical to dimina-web-client's fs-core package) —
    // runs in browser main-thread + worker contexts, never touched to satisfy lint.
    files: ["src/*.js"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.worker,
      },
    },
    rules: {
      // Ported worker code destructures a couple of fields it doesn't use at
      // every call site; the file is frozen byte-for-byte, so the rule is
      // disabled here rather than trimmed upstream.
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  {
    // Same ported-file constraint for the hand-authored .d.ts companions:
    // they type loosely-shaped external handles (`fs: any`) on purpose (see
    // each file's header comment), so `no-explicit-any` is disabled here.
    files: ["src/*.d.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    // sync/ is hand-authored (not a ported/frozen file): it runs in both
    // browser (devtools/web-client) and Node (vitest) hosts, so it needs
    // both globals, but keeps the package's NORMAL rules — no
    // no-unused-vars/no-explicit-any relaxation like the src/ overrides
    // above.
    files: ["sync/**/*.js"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },
  {
    ignores: ["coverage/**"],
  },
];
