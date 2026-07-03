// Test-coverage ratchet — reads the v8 `coverage-summary.json` each package's
// `test` script emits (`--coverage.enabled --coverage.reporter=json-summary
// --coverage.reportsDirectory=<dir>`) and gates on lines coverage. The vitest
// configs pin `coverage.include` to all of `src/**`, so the denominator counts
// untested files too — adding a file with no tests lowers the number just like
// deleting a test does.
//
// Suite enumeration reuses test-report's parse of the `scripts.test` text (the
// single source of truth for which vitest suites exist): the i-th
// --outputFile.json names the i-th suite's key, and the i-th
// --coverage.reportsDirectory is that suite's coverage dir. A count mismatch —
// including "emits a test report but no coverage at all" — is an error, not a
// silently uncounted suite; so is a declared summary missing from disk.

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Adapter, MeasureOptions, MeasureResult } from '../lib/types.ts';
import { expectedReportsOf } from './test-report.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// The coverage dirs a package's `test` script declares, one per vitest suite,
// keyed identically to the test-report dimension.
export function expectedCoverageOf(
  pkgName: string,
  testScript: string | undefined,
): Array<{ key: string; dir: string }> {
  const reports = expectedReportsOf(pkgName, testScript);
  if (reports.length === 0) return [];
  const dirs = [...(testScript ?? '').matchAll(/--coverage\.reportsDirectory=(\S+)/g)].map((m) => m[1]);
  if (dirs.length !== reports.length) {
    throw new Error(
      `package "${pkgName}" declares ${reports.length} vitest report(s) but ${dirs.length} ` +
        '--coverage.reportsDirectory flag(s) — every suite must emit a coverage summary so the ' +
        'test-coverage ratchet can count it.',
    );
  }
  return reports.map((r, i) => ({ key: r.key, dir: dirs[i] }));
}

// Extracts the lines counters from a parsed coverage-summary.json; anything that
// isn't a real summary shape must throw rather than read as covered.
export function linesCoverageOf(
  summary: unknown,
  context: string,
): { covered: number; total: number; pct: number } {
  const lines = (summary as { total?: { lines?: unknown } } | null)?.total?.lines as
    | { covered?: unknown; total?: unknown; pct?: unknown }
    | undefined;
  const covered = lines?.covered;
  const total = lines?.total;
  const pct = lines?.pct;
  if (
    typeof covered !== 'number' || !Number.isFinite(covered) ||
    typeof total !== 'number' || !Number.isFinite(total) ||
    typeof pct !== 'number' || !Number.isFinite(pct)
  ) {
    throw new Error(`${context}: not a coverage-summary.json (total.lines counters missing or not numbers)`);
  }
  return { covered, total, pct };
}

async function measure(opts?: MeasureOptions): Promise<MeasureResult> {
  const root = opts?.root ?? ROOT;
  const packagesDir = join(root, 'packages');
  const breakdown: Record<string, number> = {};
  let covered = 0;
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
    for (const { key, dir } of expectedCoverageOf(entry.name, pkg.scripts?.test)) {
      const file = join(dir, 'coverage-summary.json');
      let raw: string;
      try {
        raw = await readFile(join(pkgDir, file), 'utf8');
      } catch {
        throw new Error(
          `missing ${file} for package "${entry.name}" — run \`pnpm test\` first so the coverage summary exists.`,
        );
      }
      const lines = linesCoverageOf(JSON.parse(raw) as unknown, key);
      breakdown[key] = lines.pct;
      covered += lines.covered;
      total += lines.total;
    }
  }
  // Aggregate over real line counts, not an average of per-suite percentages —
  // a huge suite and a tiny one must not weigh the same.
  const value = total === 0 ? 100 : Math.round((covered / total) * 10000) / 100;
  return { value, unit: '% lines', breakdown };
}

const adapter: Adapter = {
  id: 'test-coverage',
  title: 'Lines covered by tests (vitest v8, all src in denominator)',
  direction: 'higher-is-better',
  // No suite's lines coverage may drop, even if another suite improving keeps
  // the aggregate flat.
  gate: 'per-key-value',
  measure,
};

export default adapter;
