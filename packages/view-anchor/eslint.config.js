import { config } from "@dimina-kit/eslint-config/react-internal";

/** @type {import("eslint").Linter.Config[]} */
export default [
  ...config,
  {
    // Visual docs (HTML/MDX) + the docs bundler script are not app source we lint.
    ignores: ["dist/**", "docs/**", "scripts/**"],
  },
];
