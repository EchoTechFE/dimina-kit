import { config } from "@dimina-kit/eslint-config/base";

/** @type {import("eslint").Linter.Config[]} */
export default [
  // Build output and Node tooling scripts are not part of the published app
  // source — keep them out of the lint gate (rootDir=src governs typecheck the
  // same way).
  { ignores: ["dist/**", "dist-app/**", "scripts/**", "*.mjs"] },
  ...config,
];
