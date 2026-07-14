// Guards the test-coverage gate adapter, whose job is to make a v8/istanbul
// lines-coverage regression on any suite show up as a red `pawl:check`
// instead of silently disappearing. Three contracts are covered:
//   - expectedCoverageOf: parses a package's `scripts.test` text into the
//     coverage-summary.json director(y/ies) it declares, deriving the same
//     stable per-suite key test-report uses. A vitest package whose
//     --outputFile.json count and --coverage.reportsDirectory count disagree
//     (including "declares reports but no coverage dir at all") must fail
//     loud rather than be silently excluded from the count.
//   - linesCoverageOf: extracts { covered, total, pct } from a parsed v8
//     coverage-summary.json, fail-loud on any shape that isn't a real one.
//   - measure(): the end-to-end scan across `<root>/packages/*/package.json`,
//     aggregating covered/total lines (not averaging per-suite pct) into
//     `value`, breaking down per-suite pct into `breakdown`, and rejecting
//     (not swallowing) when a declared coverage-summary.json is missing from
//     disk.
// Run with: node --test tools/pawl/test-coverage.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import adapter, { expectedCoverageOf, linesCoverageOf } from './adapters/test-coverage.ts';

function summary(covered: number, total: number, pct: number): unknown {
  return { total: { lines: { covered, total, pct } } };
}

async function makeRoot(
  pkgs: Record<string, { packageJson: unknown; coverage?: Record<string, unknown> }>,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'gate-test-coverage-'));
  const packagesDir = join(root, 'packages');
  await mkdir(packagesDir, { recursive: true });
  for (const [name, def] of Object.entries(pkgs)) {
    const pkgDir = join(packagesDir, name);
    await mkdir(pkgDir, { recursive: true });
    await writeFile(join(pkgDir, 'package.json'), JSON.stringify(def.packageJson, null, 2));
    for (const [dir, content] of Object.entries(def.coverage ?? {})) {
      const outDir = join(pkgDir, dir);
      await mkdir(outDir, { recursive: true });
      await writeFile(join(outDir, 'coverage-summary.json'), JSON.stringify(content));
    }
  }
  return root;
}

function withCleanup(t: { after: (fn: () => unknown) => void }, root: string): void {
  t.after(() => rm(root, { recursive: true, force: true }));
}

describe('adapter shape', () => {
  it('exposes the fixed id/direction/gate the engine keys the metric on', () => {
    assert.equal(adapter.id, 'test-coverage');
    assert.equal(adapter.direction, 'higher-is-better');
    assert.equal(adapter.gate, 'per-key-value');
    assert.equal(typeof adapter.title, 'string');
    assert.ok(adapter.title.length > 0);
    assert.equal(typeof adapter.measure, 'function');
  });
});

describe('expectedCoverageOf', () => {
  it('returns no suites for a package with no test script', () => {
    assert.deepEqual(expectedCoverageOf('pkg-a', undefined), []);
  });

  it('returns no suites for a test script that does not invoke vitest', () => {
    assert.deepEqual(expectedCoverageOf('pkg-a', 'node scripts/check.mjs'), []);
  });

  it('parses a single vitest suite into one coverage dir keyed by the package name', () => {
    const script =
      'vitest run --outputFile.json=test-report.json --coverage.enabled --coverage.reporter=json-summary --coverage.reportsDirectory=coverage';
    assert.deepEqual(expectedCoverageOf('pkg-a', script), [{ key: 'pkg-a', dir: 'coverage' }]);
  });

  it('parses the electron-deck two-suite shape into two distinct keys and dirs', () => {
    const script =
      'vitest run --outputFile.json=test-report.json --coverage.reportsDirectory=coverage && vitest run --config x.ts --outputFile.json=test-report.dock-react.json --coverage.reportsDirectory=coverage/dock-react';
    assert.deepEqual(expectedCoverageOf('electron-deck', script), [
      { key: 'electron-deck', dir: 'coverage' },
      { key: 'electron-deck/dock-react', dir: 'coverage/dock-react' },
    ]);
  });

  it('fails loud when a vitest test script declares no --outputFile.json at all', () => {
    assert.throws(
      () => expectedCoverageOf('pkg-a', 'vitest run --coverage.reportsDirectory=coverage'),
      (err: unknown) => err instanceof Error && err.message.includes('pkg-a'),
    );
  });

  it('fails loud when a suite has an --outputFile.json but no matching --coverage.reportsDirectory', () => {
    assert.throws(
      () => expectedCoverageOf('pkg-a', 'vitest run --outputFile.json=test-report.json'),
      (err: unknown) => err instanceof Error && err.message.includes('pkg-a'),
    );
  });

  it('fails loud when the outputFile and coverage-dir counts disagree across suites', () => {
    const script =
      'vitest run --outputFile.json=test-report.json --coverage.reportsDirectory=coverage && vitest run --outputFile.json=test-report.dock-react.json';
    assert.throws(
      () => expectedCoverageOf('electron-deck', script),
      (err: unknown) => err instanceof Error && err.message.includes('electron-deck'),
    );
  });
});

describe('linesCoverageOf', () => {
  it('reads covered/total/pct off a well-formed v8 coverage-summary.json', () => {
    assert.deepEqual(linesCoverageOf(summary(8, 10, 80), 'pkg-a'), { covered: 8, total: 10, pct: 80 });
  });

  it('rejects a summary that is not an object', () => {
    assert.throws(
      () => linesCoverageOf('not-json', 'pkg-a'),
      (err: unknown) => err instanceof Error && err.message.includes('pkg-a'),
    );
  });

  it('rejects null', () => {
    assert.throws(
      () => linesCoverageOf(null, 'pkg-a'),
      (err: unknown) => err instanceof Error && err.message.includes('pkg-a'),
    );
  });

  it('rejects a summary missing total.lines', () => {
    assert.throws(
      () => linesCoverageOf({ total: { statements: { covered: 1, total: 1, pct: 100 } } }, 'pkg-a'),
      (err: unknown) => err instanceof Error && err.message.includes('pkg-a'),
    );
  });

  it('rejects a non-numeric lines field', () => {
    assert.throws(
      () => linesCoverageOf(summary(8, 10, '80' as unknown as number), 'pkg-a'),
      (err: unknown) => err instanceof Error && err.message.includes('pkg-a'),
    );
  });

  it('rejects a NaN lines field', () => {
    assert.throws(
      () => linesCoverageOf(summary(Number.NaN, 10, 80), 'pkg-a'),
      (err: unknown) => err instanceof Error && err.message.includes('pkg-a'),
    );
  });
});

describe('measure', () => {
  it('aggregates covered/total lines across suites for value, not the average of per-suite pct', async (t) => {
    // pkg-a: 90/100 lines (pct 90). pkg-b: 10/1000 lines (pct 1). A naive
    // average of pcts would read (90+1)/2 = 45.5; the correct aggregate
    // reading is (90+10)/(100+1000)*100 = 9.09, which this asserts on.
    const root = await makeRoot({
      'pkg-a': {
        packageJson: {
          name: 'pkg-a',
          scripts: {
            test: 'vitest run --outputFile.json=test-report.json --coverage.reportsDirectory=coverage',
          },
        },
        coverage: { coverage: summary(90, 100, 90) },
      },
      'pkg-b': {
        packageJson: {
          name: 'pkg-b',
          scripts: {
            test: 'vitest run --outputFile.json=test-report.json --coverage.reportsDirectory=coverage',
          },
        },
        coverage: { coverage: summary(10, 1000, 1) },
      },
    });
    withCleanup(t, root);

    const result = await adapter.measure({ root });
    assert.equal(result.value, 9.09);
    assert.deepEqual(result.breakdown, { 'pkg-a': 90, 'pkg-b': 1 });
    assert.ok(result.unit && result.unit.includes('%'));
  });

  it('keys the electron-deck two-suite package as two separate breakdown entries', async (t) => {
    const root = await makeRoot({
      'electron-deck': {
        packageJson: {
          name: 'electron-deck',
          scripts: {
            test: 'vitest run --outputFile.json=test-report.json --coverage.reportsDirectory=coverage && vitest run --config x.ts --outputFile.json=test-report.dock-react.json --coverage.reportsDirectory=coverage/dock-react',
          },
        },
        coverage: {
          coverage: summary(50, 100, 50),
          'coverage/dock-react': summary(30, 40, 75),
        },
      },
    });
    withCleanup(t, root);

    const result = await adapter.measure({ root });
    assert.deepEqual(result.breakdown, { 'electron-deck': 50, 'electron-deck/dock-react': 75 });
    assert.equal(result.value, 57.14); // (50+30) / (100+40) * 100
  });

  it('reports 100 when the aggregated line total across suites is zero', async (t) => {
    const root = await makeRoot({
      'pkg-a': {
        packageJson: {
          name: 'pkg-a',
          scripts: {
            test: 'vitest run --outputFile.json=test-report.json --coverage.reportsDirectory=coverage',
          },
        },
        coverage: { coverage: summary(0, 0, 100) },
      },
    });
    withCleanup(t, root);

    const result = await adapter.measure({ root });
    assert.equal(result.value, 100);
  });

  it('ignores a package that has no test script at all', async (t) => {
    const root = await makeRoot({
      'pkg-a': { packageJson: { name: 'pkg-a' } },
      'pkg-b': {
        packageJson: {
          name: 'pkg-b',
          scripts: { test: 'vitest run --outputFile.json=test-report.json --coverage.reportsDirectory=coverage' },
        },
        coverage: { coverage: summary(5, 10, 50) },
      },
    });
    withCleanup(t, root);

    const result = await adapter.measure({ root });
    assert.deepEqual(result.breakdown, { 'pkg-b': 50 });
  });

  it('ignores a package whose test script does not run vitest', async (t) => {
    const root = await makeRoot({
      'pkg-a': { packageJson: { name: 'pkg-a', scripts: { test: 'node scripts/check.mjs' } } },
    });
    withCleanup(t, root);

    const result = await adapter.measure({ root });
    assert.equal(result.value, 100);
    assert.deepEqual(result.breakdown, {});
  });

  it('ignores a packages/ entry that has no package.json', async (t) => {
    const root = await makeRoot({
      'pkg-a': {
        packageJson: {
          name: 'pkg-a',
          scripts: { test: 'vitest run --outputFile.json=test-report.json --coverage.reportsDirectory=coverage' },
        },
        coverage: { coverage: summary(3, 3, 100) },
      },
    });
    await mkdir(join(root, 'packages', 'not-a-package'), { recursive: true });
    await writeFile(join(root, 'packages', 'not-a-package', 'README.md'), '# nothing here');
    withCleanup(t, root);

    const result = await adapter.measure({ root });
    assert.deepEqual(result.breakdown, { 'pkg-a': 100 });
  });

  it('rejects when a declared coverage-summary.json is missing from disk', async (t) => {
    const root = await makeRoot({
      'pkg-a': {
        packageJson: {
          name: 'pkg-a',
          scripts: { test: 'vitest run --outputFile.json=test-report.json --coverage.reportsDirectory=coverage' },
        },
        // No `coverage` written: the dir the test script declares never
        // lands on disk, e.g. because `pnpm test` was never run for this package.
      },
    });
    withCleanup(t, root);

    await assert.rejects(
      () => adapter.measure({ root }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('pkg-a') || err.message.includes('coverage-summary.json'));
        assert.ok(err.message.includes('pnpm test'));
        return true;
      },
    );
  });
});
