import { config } from "@dimina-kit/eslint-config/base";

/** @type {import("eslint").Linter.Config[]} */
export default [
  // Runnable demos live outside src and are not part of the published build or
  // the typecheck (rootDir=src); keep them out of the lint gate too. The
  // CI-gate scripts (e.g. check-trust-seal.mjs) are Node tooling, not app source.
  { ignores: ["examples/**", "dist/**", "scripts/**"] },
  ...config,
];
