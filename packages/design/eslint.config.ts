import { config } from "@dimina-kit/eslint-config/base";

export default [
  ...config,
  {
    ignores: ["coverage/**", "dist/**", "tailwind-preset.cjs"],
  },
];
