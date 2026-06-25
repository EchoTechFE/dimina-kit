// Smoke-tests the lint-backed adapters' wiring: a function above the cognitive
// threshold surfaces exactly one sonarjs violation; an explicit `any` surfaces a
// no-explicit-any violation. The rule scoring itself belongs to the upstream
// plugins and is not re-tested here.
// Run with: node --test tools/ratchet/cognitive-complexity.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import sonarjs from 'eslint-plugin-sonarjs';
import tseslint from 'typescript-eslint';
import { makeEslint } from './lib/eslint.mjs';
import { THRESHOLD } from './adapters/cognitive-complexity.mjs';

async function lint(eslint, code) {
  const [result] = await eslint.lintText(code, { filePath: 'probe.ts' });
  return result.messages;
}

test('sonarjs flags a function above the cognitive threshold', async () => {
  const eslint = makeEslint({
    plugins: { sonarjs },
    rules: { 'sonarjs/cognitive-complexity': ['error', THRESHOLD] },
  });
  const body = 'if(a){}'.repeat(THRESHOLD + 5);
  const msgs = await lint(eslint, `export function f(a: unknown){ ${body} }`);
  assert.equal(msgs.filter((m) => m.ruleId === 'sonarjs/cognitive-complexity').length, 1);
});

test('no-explicit-any flags an explicit any', async () => {
  const eslint = makeEslint({
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: { '@typescript-eslint/no-explicit-any': 'error' },
  });
  const msgs = await lint(eslint, 'export const x = (v: unknown) => v as any;');
  assert.equal(msgs.filter((m) => m.ruleId === '@typescript-eslint/no-explicit-any').length, 1);
});
