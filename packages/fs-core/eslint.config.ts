import { config } from "@dimina-kit/eslint-config/base";
import globals from "globals";

export default [
  ...config,
  {
    // Ported TCB source — runs in browser main-thread + worker contexts.
    files: ["src/*.ts"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.worker,
      },
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
    // Node build script (esbuild CLI wrapper), not shipped runtime code.
    files: ["build-workers.mjs"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    ignores: ["coverage/**"],
  },
];
