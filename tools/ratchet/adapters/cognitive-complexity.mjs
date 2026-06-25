// Cognitive-complexity ratchet — delegates scoring to eslint-plugin-sonarjs, the
// canonical SonarSource implementation (it IS the SonarJS engine), driven through
// ESLint's Node API. We do not reimplement the algorithm.
//
// The lint setup is isolated in ../lib/eslint.mjs and never touches the workspace
// lint config. That isolation is deliberate: even if app linting migrates to oxc
// this dimension keeps working — and oxlint cannot compute cognitive complexity
// anyway, since SonarJS-class rules are type-aware (oxc-project/oxc#4863).
//
// The metric is the number of functions whose cognitive complexity exceeds
// THRESHOLD (Sonar's default of 15). The breakdown names each offender and its
// score, parsed from the rule's message.

import sonarjs from 'eslint-plugin-sonarjs';
import { lintAll } from '../lib/eslint.mjs';

export const THRESHOLD = 15;
const RULE = 'sonarjs/cognitive-complexity';

async function measure() {
  const hits = await lintAll({
    plugins: { sonarjs },
    rules: { [RULE]: ['error', THRESHOLD] },
  });
  const breakdown = {};
  let count = 0;
  for (const h of hits) {
    if (h.ruleId !== RULE) continue;
    const score = Number(/from (\d+) to/.exec(h.message)?.[1] ?? 0);
    breakdown[`${h.file}:${h.line}`] = score;
    count += 1;
  }
  return { value: count, unit: `fns > ${THRESHOLD}`, breakdown };
}

export default {
  id: 'cognitive-complexity',
  title: `Functions over cognitive-complexity ${THRESHOLD} (sonarjs)`,
  direction: 'lower-is-better',
  // No file may gain over-threshold functions, even if another file loses some.
  gate: 'per-file-count',
  measure,
};
