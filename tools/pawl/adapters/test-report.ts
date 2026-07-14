// Test-report gate — counts tests that actually PASSED, straight from the
// vitest JSON reports the packages' `test` scripts emit (`--outputFile.json=…`).
// Reading the run report instead of grepping source for `it(` means every way a
// test can stop counting — deleted, `.skip`ped, excluded from the config, or
// newly failing — shows up as the same thing: a lower passed count, and a red
// `pawl:check`.
//
// The set of reports is derived from each package's `scripts.test` text, so the
// script that PRODUCES a report is the single source of truth for which reports
// must exist. Two fail-loud invariants keep the count honest:
//   - a `test` script that runs vitest but declares no --outputFile.json is an
//     error, not a silently uncounted package;
//   - a declared report missing from disk is an error ("run `pnpm test` first"),
//     not a zero. In CI the test step always precedes `pawl:check`, so
//     reports are fresh by construction.

import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Adapter, MeasureOptions, MeasureResult } from '../lib/types.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// The vitest JSON reports a package's `test` script declares, one breakdown key
// per report: `test-report.json` keys as the package name itself, any other
// `test-report.<suffix>.json` as `<pkg>/<suffix>` (e.g. electron-deck's second
// vitest config → `electron-deck/dock-react`).
export function expectedReportsOf(
  pkgName: string,
  testScript: string | undefined,
): Array<{ key: string; file: string }> {
  if (!testScript || !testScript.includes('vitest')) return [];
  const out: Array<{ key: string; file: string }> = [];
  for (const m of testScript.matchAll(/--outputFile\.json=(\S+)/g)) {
    const file = m[1];
    const base = basename(file);
    const suffix = base === 'test-report.json' ? null : /^test-report\.(.+)\.json$/.exec(base)?.[1] ?? base;
    out.push({ key: suffix === null ? pkgName : `${pkgName}/${suffix}`, file });
  }
  if (out.length === 0) {
    throw new Error(
      `package "${pkgName}" runs vitest but its test script declares no --outputFile.json report — ` +
        'wire one up so the test-report gate can count it.',
    );
  }
  return out;
}

// Extracts numPassedTests from a parsed vitest JSON report; anything that isn't
// a real report shape (corrupt/truncated file, a different tool's output) must
// throw rather than read as 0 passed tests.
export function passedCountOf(report: unknown, context: string): number {
  const n = (report as { numPassedTests?: unknown } | null)?.numPassedTests;
  if (typeof report !== 'object' || report === null || typeof n !== 'number' || Number.isNaN(n)) {
    throw new Error(`${context}: not a vitest JSON report (numPassedTests missing or not a number)`);
  }
  return n;
}

async function measure(opts?: MeasureOptions): Promise<MeasureResult> {
  const root = opts?.root ?? ROOT;
  const packagesDir = join(root, 'packages');
  const breakdown: Record<string, number> = {};
  let total = 0;
  for (const entry of await readdir(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkgDir = join(packagesDir, entry.name);
    let manifest: string;
    try {
      manifest = await readFile(join(pkgDir, 'package.json'), 'utf8');
    } catch {
      continue; // not a package
    }
    const pkg = JSON.parse(manifest) as { scripts?: { test?: string } };
    for (const { key, file } of expectedReportsOf(entry.name, pkg.scripts?.test)) {
      let raw: string;
      try {
        raw = await readFile(join(pkgDir, file), 'utf8');
      } catch {
        throw new Error(
          `missing ${file} for package "${entry.name}" — run \`pnpm test\` first so the vitest JSON report exists.`,
        );
      }
      const passed = passedCountOf(JSON.parse(raw) as unknown, key);
      breakdown[key] = passed;
      total += passed;
    }
  }
  return { value: total, unit: 'passed tests', breakdown };
}

const adapter: Adapter = {
  id: 'test-report',
  title: 'Passed tests (vitest JSON reports)',
  direction: 'higher-is-better',
  // No package's passed-test count may drop, even if another package gaining
  // tests keeps the total flat.
  gate: 'per-key-value',
  measure,
};

export default adapter;
