// Type-escape ratchet — counts the escape hatches that quietly erode type safety:
// explicit `any` (annotations and `as any` casts) and `@ts-*` suppression
// comments. It uses the mature typescript-eslint rules `no-explicit-any` and
// `ban-ts-comment` rather than a regex, so comments and string literals never
// produce false matches the way a textual scan would.
//
// These rules are purely syntactic, so unlike cognitive complexity they are
// portable to oxlint — only ../lib/eslint.mjs changes if the linter is swapped.
// Scope is production source only (test files legitimately cast around mocks).

import tseslint from 'typescript-eslint';
import { lintAll } from '../lib/eslint.mjs';

const RULES = {
  '@typescript-eslint/no-explicit-any': 'error',
  '@typescript-eslint/ban-ts-comment': 'error',
};

async function measure() {
  const hits = await lintAll({
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: RULES,
  });
  const breakdown = {};
  let count = 0;
  for (const h of hits) {
    if (!(h.ruleId in RULES)) continue;
    const tag = h.ruleId.endsWith('ban-ts-comment') ? 'ts-comment' : 'any';
    breakdown[`${h.file}:${h.line} (${tag})`] = 1;
    count += 1;
  }
  return { value: count, unit: 'explicit any / ts-comments', breakdown };
}

export default {
  id: 'type-escapes',
  title: 'Explicit any + @ts-* suppressions (typescript-eslint)',
  direction: 'lower-is-better',
  // No file may gain escapes, even if another sheds them (net-zero can't hide it).
  gate: 'per-file-count',
  measure,
};
