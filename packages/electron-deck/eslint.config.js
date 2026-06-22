import { config } from "@dimina-kit/eslint-config/base";

/** @type {import("eslint").Linter.Config[]} */
export default [
  // Runnable demos live outside src and are not part of the published build or
  // the typecheck (rootDir=src); keep them out of the lint gate too. The
  // CI-gate scripts (e.g. check-trust-seal.mjs) are Node tooling, not app source.
  { ignores: ["examples/**", "dist/**", "scripts/**", "coverage/**"] },
  ...config,
  // React component specs (`*.test.tsx`) narrow the `LayoutNode` union via
  // `as any` to reach into split children — a pragmatic test-only escape hatch.
  // Relax `no-explicit-any` for these specs only; the published surface and all
  // `*.test.ts` files stay strict.
  {
    files: ["src/**/*.test.tsx"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
];
