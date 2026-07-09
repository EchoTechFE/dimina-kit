import { config } from "@dimina-kit/eslint-config/base";
import globals from "globals";

/** @type {import("eslint").Linter.Config[]} */
export default [
  ...config,
  {
    // Ported TCB source — runs in browser main-thread + worker contexts.
    // Loosely-shaped external handles/RPC message payloads are typed `any`
    // on purpose throughout (see each file's header comment: re-deriving
    // their shape buys nothing), so `no-explicit-any` stays off here.
    files: ["src/*.ts"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.worker,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    // sync/ is hand-authored (not a ported/frozen file): it runs in both
    // browser (devtools/web-client) and Node (vitest) hosts, so it needs
    // both globals, but keeps the package's NORMAL rules — no
    // no-explicit-any relaxation like the src/ override above.
    files: ["sync/**/*.ts"],
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
