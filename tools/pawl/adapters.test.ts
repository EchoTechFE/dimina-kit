// Smoke-tests the isolated ESLint config consumed by pawl's eslint builtin.
// The rule implementations belong to the upstream plugins; this only guards
// parser/plugin/rule wiring and the production-source file scope.
// Run with: node --test tools/pawl/adapters.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ESLint } from 'eslint';
import { join } from 'node:path';
import { ROOT } from './lib/root.ts';

const CONFIG = join(ROOT, 'tools/pawl/eslint-gate.config.mjs');
const THRESHOLD = 15;

async function lint(code: string) {
  const eslint = new ESLint({
    cwd: ROOT,
    overrideConfigFile: CONFIG,
  });
  const [result] = await eslint.lintText(code, {
    filePath: join(ROOT, 'packages/devtools/src/pawl-probe.ts'),
  });
  return result?.messages ?? [];
}

test('sonarjs flags a function above the cognitive threshold', async () => {
  const body = 'if(a){}'.repeat(THRESHOLD + 5);
  const msgs = await lint(`export function f(a: unknown){ ${body} }`);
  assert.equal(msgs.filter((m) => m.ruleId === 'sonarjs/cognitive-complexity').length, 1);
});

test('no-explicit-any flags an explicit any', async () => {
  const msgs = await lint('export const x = (v: unknown) => v as any;');
  assert.equal(msgs.filter((m) => m.ruleId === '@typescript-eslint/no-explicit-any').length, 1);
});

test('ban-ts-comment flags TypeScript suppression comments', async () => {
  const msgs = await lint('// @ts-ignore\nexport const value = missingGlobal;');
  assert.equal(msgs.filter((m) => m.ruleId === '@typescript-eslint/ban-ts-comment').length, 1);
});
