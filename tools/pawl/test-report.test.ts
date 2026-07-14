// Guards the test-report gate adapter, whose job is to make a passed-test-count
// regression (deleted test, `.skip`, or a newly failing test) show up as a red
// `pawl:check` instead of silently disappearing. Three contracts are covered:
//   - expectedReportsOf: parses a package's `scripts.test` text into the vitest
//     JSON report(s) it declares, deriving a stable key per report. A vitest
//     package that forgot to wire an --outputFile.json must fail loud rather than
//     be silently excluded from the count.
//   - passedCountOf: extracts `numPassedTests` from a parsed report, fail-loud on
//     any shape that isn't a real vitest JSON report.
//   - measure(): the end-to-end scan across `<root>/packages/*/package.json`,
//     summing passed counts into `value`/`breakdown`, and rejecting (not
//     swallowing) when a declared report file is missing from disk.
// Run with: node --test tools/pawl/test-report.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import adapter, { expectedReportsOf, passedCountOf } from './adapters/test-report.ts';

async function makeRoot(pkgs: Record<string, { packageJson: unknown; reports?: Record<string, unknown> }>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'gate-test-report-'));
  const packagesDir = join(root, 'packages');
  await mkdir(packagesDir, { recursive: true });
  for (const [name, def] of Object.entries(pkgs)) {
    const pkgDir = join(packagesDir, name);
    await mkdir(pkgDir, { recursive: true });
    await writeFile(join(pkgDir, 'package.json'), JSON.stringify(def.packageJson, null, 2));
    for (const [file, content] of Object.entries(def.reports ?? {})) {
      await writeFile(join(pkgDir, file), JSON.stringify(content));
    }
  }
  return root;
}

function withCleanup(t: { after: (fn: () => unknown) => void }, root: string): void {
  t.after(() => rm(root, { recursive: true, force: true }));
}

describe('adapter shape', () => {
  it('exposes the fixed id/direction/gate the engine keys the metric on', () => {
    assert.equal(adapter.id, 'test-report');
    assert.equal(adapter.direction, 'higher-is-better');
    assert.equal(adapter.gate, 'per-key-value');
    assert.equal(typeof adapter.title, 'string');
    assert.ok(adapter.title.length > 0);
    assert.equal(typeof adapter.measure, 'function');
  });
});

describe('expectedReportsOf', () => {
  it('returns no reports for a package with no test script', () => {
    assert.deepEqual(expectedReportsOf('pkg-a', undefined), []);
  });

  it('returns no reports for a test script that does not invoke vitest', () => {
    assert.deepEqual(expectedReportsOf('pkg-a', 'node scripts/check.mjs'), []);
  });

  it('parses a single vitest --outputFile.json into one report keyed by the package name', () => {
    const out = expectedReportsOf('pkg-a', 'vitest run --outputFile.json=./test-report.json');
    assert.deepEqual(out, [{ key: 'pkg-a', file: './test-report.json' }]);
  });

  it('preserves the declared path verbatim, including a ./ prefix', () => {
    const out = expectedReportsOf('pkg-a', 'vitest run --outputFile.json=./nested/test-report.json');
    assert.equal(out[0].file, './nested/test-report.json');
  });

  it('derives a suffixed key from a non-default report basename', () => {
    const out = expectedReportsOf('pkg-a', 'vitest run --outputFile.json=./test-report.custom.json');
    assert.deepEqual(out, [{ key: 'pkg-a/custom', file: './test-report.custom.json' }]);
  });

  it('parses the electron-deck two-report shape into two distinct keys', () => {
    const script =
      'vitest run --outputFile.json=./test-report.json && vitest run --config vitest.dock-react.config.ts --outputFile.json=./test-report.dock-react.json';
    const out = expectedReportsOf('electron-deck', script);
    assert.deepEqual(out, [
      { key: 'electron-deck', file: './test-report.json' },
      { key: 'electron-deck/dock-react', file: './test-report.dock-react.json' },
    ]);
  });

  it('fails loud when a vitest test script declares no --outputFile.json', () => {
    assert.throws(
      () => expectedReportsOf('pkg-a', 'vitest run'),
      (err: unknown) => err instanceof Error && err.message.includes('pkg-a'),
    );
  });
});

describe('passedCountOf', () => {
  it('reads numPassedTests off a well-formed report', () => {
    assert.equal(passedCountOf({ numPassedTests: 42 }, 'pkg-a'), 42);
  });

  it('rejects a report that is not an object', () => {
    assert.throws(
      () => passedCountOf('not-json', 'pkg-a'),
      (err: unknown) => err instanceof Error && err.message.includes('pkg-a'),
    );
  });

  it('rejects null', () => {
    assert.throws(
      () => passedCountOf(null, 'pkg-a'),
      (err: unknown) => err instanceof Error && err.message.includes('pkg-a'),
    );
  });

  it('rejects a report missing numPassedTests', () => {
    assert.throws(
      () => passedCountOf({ numFailedTests: 0 }, 'pkg-a'),
      (err: unknown) => err instanceof Error && err.message.includes('pkg-a'),
    );
  });

  it('rejects a non-numeric numPassedTests', () => {
    assert.throws(
      () => passedCountOf({ numPassedTests: '42' }, 'pkg-a'),
      (err: unknown) => err instanceof Error && err.message.includes('pkg-a'),
    );
  });

  it('rejects a NaN numPassedTests', () => {
    assert.throws(
      () => passedCountOf({ numPassedTests: Number.NaN }, 'pkg-a'),
      (err: unknown) => err instanceof Error && err.message.includes('pkg-a'),
    );
  });
});

describe('measure', () => {
  it('sums numPassedTests across packages and breaks it down per report key', async (t) => {
    const root = await makeRoot({
      'pkg-a': {
        packageJson: { name: 'pkg-a', scripts: { test: 'vitest run --outputFile.json=./test-report.json' } },
        reports: { 'test-report.json': { numPassedTests: 10 } },
      },
      'pkg-b': {
        packageJson: { name: 'pkg-b', scripts: { test: 'vitest run --outputFile.json=./test-report.json' } },
        reports: { 'test-report.json': { numPassedTests: 5 } },
      },
    });
    withCleanup(t, root);

    const result = await adapter.measure({ root });
    assert.equal(result.value, 15);
    assert.deepEqual(result.breakdown, { 'pkg-a': 10, 'pkg-b': 5 });
    assert.ok(result.unit && result.unit.includes('passed'));
  });

  it('keys the electron-deck two-report package as two separate breakdown entries', async (t) => {
    const root = await makeRoot({
      'electron-deck': {
        packageJson: {
          name: 'electron-deck',
          scripts: {
            test: 'vitest run --outputFile.json=./test-report.json && vitest run --config vitest.dock-react.config.ts --outputFile.json=./test-report.dock-react.json',
          },
        },
        reports: {
          'test-report.json': { numPassedTests: 100 },
          'test-report.dock-react.json': { numPassedTests: 20 },
        },
      },
    });
    withCleanup(t, root);

    const result = await adapter.measure({ root });
    assert.equal(result.value, 120);
    assert.deepEqual(result.breakdown, { 'electron-deck': 100, 'electron-deck/dock-react': 20 });
  });

  it('ignores a package that has no test script at all', async (t) => {
    const root = await makeRoot({
      'pkg-a': { packageJson: { name: 'pkg-a' } },
      'pkg-b': {
        packageJson: { name: 'pkg-b', scripts: { test: 'vitest run --outputFile.json=./test-report.json' } },
        reports: { 'test-report.json': { numPassedTests: 7 } },
      },
    });
    withCleanup(t, root);

    const result = await adapter.measure({ root });
    assert.equal(result.value, 7);
    assert.deepEqual(result.breakdown, { 'pkg-b': 7 });
  });

  it('ignores a package whose test script does not run vitest', async (t) => {
    const root = await makeRoot({
      'pkg-a': { packageJson: { name: 'pkg-a', scripts: { test: 'node scripts/check.mjs' } } },
    });
    withCleanup(t, root);

    const result = await adapter.measure({ root });
    assert.equal(result.value, 0);
    assert.deepEqual(result.breakdown, {});
  });

  it('ignores a packages/ entry that has no package.json', async (t) => {
    const root = await makeRoot({
      'pkg-a': {
        packageJson: { name: 'pkg-a', scripts: { test: 'vitest run --outputFile.json=./test-report.json' } },
        reports: { 'test-report.json': { numPassedTests: 3 } },
      },
    });
    await mkdir(join(root, 'packages', 'not-a-package'), { recursive: true });
    await writeFile(join(root, 'packages', 'not-a-package', 'README.md'), '# nothing here');
    withCleanup(t, root);

    const result = await adapter.measure({ root });
    assert.equal(result.value, 3);
    assert.deepEqual(result.breakdown, { 'pkg-a': 3 });
  });

  it('rejects when a declared vitest report file is missing from disk', async (t) => {
    const root = await makeRoot({
      'pkg-a': {
        packageJson: { name: 'pkg-a', scripts: { test: 'vitest run --outputFile.json=./test-report.json' } },
        // No `reports` written: the file the test script declares never lands on disk,
        // e.g. because `pnpm test` was never run for this package.
      },
    });
    withCleanup(t, root);

    await assert.rejects(
      () => adapter.measure({ root }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('pkg-a') || err.message.includes('test-report.json'));
        assert.ok(err.message.includes('pnpm test'));
        return true;
      },
    );
  });
});
