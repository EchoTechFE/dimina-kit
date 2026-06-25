// Shared ESLint plumbing for the lint-backed ratchet adapters (cognitive
// complexity, type escapes). Adapters pass the plugins + rules they care about;
// this module owns the parser, the production-source scope, and the empty-package
// handling. It is the single place to repoint if the linter is ever swapped
// (e.g. to oxlint) — the adapters stay as-is.

import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PACKAGES = join(ROOT, 'packages');

// Production source only — test files legitimately bend the rules around fixtures.
const IGNORES = ['**/*.test.{ts,tsx}', '**/*.spec.{ts,tsx}', '**/*.d.ts', '**/dist/**'];

export function makeEslint({ plugins, rules }) {
  return new ESLint({
    cwd: ROOT,
    errorOnUnmatchedPattern: false, // empty packages (demo-app/workbench) ship no src
    overrideConfigFile: true,
    overrideConfig: [
      { ignores: IGNORES },
      {
        files: ['**/*.ts', '**/*.tsx'],
        // Ignore inline `eslint-disable` comments: the ratchet must measure the
        // real escape surface, not what has been suppressed away — otherwise a new
        // violation could slip past simply by adding a disable directive.
        linterOptions: { noInlineConfig: true },
        languageOptions: {
          parser: tseslint.parser,
          parserOptions: { ecmaFeatures: { jsx: true } },
        },
        plugins,
        rules,
      },
    ],
  });
}

async function srcGlobs() {
  const pkgs = await readdir(PACKAGES, { withFileTypes: true });
  const globs = [];
  for (const pkg of pkgs) {
    if (!pkg.isDirectory()) continue;
    globs.push(`packages/${pkg.name}/src/**/*.ts`, `packages/${pkg.name}/src/**/*.tsx`);
  }
  return globs;
}

// Lint production source and return every rule message as
// [{ file (relative), line, ruleId, message }]. Adapters filter by ruleId.
export async function lintAll({ plugins, rules }) {
  const eslint = makeEslint({ plugins, rules });
  const results = await eslint.lintFiles(await srcGlobs());
  const hits = [];
  for (const r of results) {
    for (const m of r.messages) {
      hits.push({
        file: r.filePath.split(`${ROOT}/`).pop(),
        line: m.line,
        ruleId: m.ruleId,
        message: m.message,
      });
    }
  }
  return hits;
}
