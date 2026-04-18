import { config } from "@dimina-kit/eslint-config/base";

/** @type {import("eslint").Linter.Config[]} */
export default [
  ...config,
  {
    ignores: ["fe/**"],
  },
];
