// Guards five gaps an adversarial review found in the ratchet engine and the
// circular-deps adapter — each would let a real regression slip past the
// `pnpm ratchet:check` / `baseline-guard` gate silently:
//   1. baseline-guard must fail loud when git itself errors (bad ref, corrupt
//      repo, …) — it must only treat "ref exists but the snapshot path is
//      absent there" as the legitimate skip case.
//   2. a snapshot.json with the wrong shape (missing metrics, a metric with
//      no numeric value, …) must not compare as "consistent" — that would
//      let a hand-corrupted or truncated snapshot pass baseline-guard for
//      free.
//   3. circular-deps must resolve tsconfig `paths` aliases (e.g. `@/*`), not
//      just relative './x' specifiers — an alias-mediated cycle is still a
//      cycle.
//   4. circular-deps must follow dynamic `import()` calls, not only static
//      import/export-from — a cycle hidden behind a dynamic import still
//      makes initialization order load-order-dependent.
//   5. circular-deps must not treat import-shaped text inside comments or
//      string literals as a real edge — that would fabricate cycles out of
//      documentation/examples.
// Run with: node --test tools/ratchet/review-hardening.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { loadBaselineSnapshotAt, snapshotShapeErrors } from './ratchet.ts';
import circularDeps from './adapters/circular-deps.ts';

async function withFixture(files: Record<string, string>, fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'ratchet-review-hardening-'));
  try {
    for (const [relPath, content] of Object.entries(files)) {
      const full = join(root, relPath);
      await mkdir(full.slice(0, full.lastIndexOf(sep)), { recursive: true });
      await writeFile(full, content, 'utf8');
    }
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
}

// A throwaway git repo with two commits: the first has no snapshot.json (so
// a ref pointing at it is a valid revision where the path is legitimately
// absent), the second adds tools/ratchet/snapshot.json (so HEAD is a valid
// revision where loadBaselineSnapshotAt should succeed). Returns both SHAs
// plus the repo root.
async function withBaselineGitFixture(
  fn: (info: { root: string; noSnapshotSha: string; withSnapshotSha: string }) => Promise<void>,
) {
  await withFixture({ 'README.md': 'no snapshot yet\n' }, async (root) => {
    git(root, ['init', '-q']);
    git(root, ['config', 'user.email', 'ratchet-test@example.com']);
    git(root, ['config', 'user.name', 'Ratchet Test']);
    git(root, ['config', 'commit.gpgsign', 'false']);
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'no snapshot yet']);
    const noSnapshotSha = git(root, ['rev-parse', 'HEAD']).trim();

    const snapshot = {
      metrics: {
        'circular-deps': { direction: 'lower-is-better', value: 2, unit: 'import cycles', breakdown: {} },
      },
    };
    await mkdir(join(root, 'tools', 'ratchet'), { recursive: true });
    await writeFile(join(root, 'tools', 'ratchet', 'snapshot.json'), JSON.stringify(snapshot, null, 2));
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'add snapshot.json']);
    const withSnapshotSha = git(root, ['rev-parse', 'HEAD']).trim();

    await fn({ root, noSnapshotSha, withSnapshotSha });
  });
}

describe('loadBaselineSnapshotAt (defect 1: git errors must not be swallowed as "no baseline")', () => {
  it('returns kind "ok" with the parsed metrics for a legitimate ref', async () => {
    await withBaselineGitFixture(async ({ root, withSnapshotSha }) => {
      const result = await loadBaselineSnapshotAt(withSnapshotSha, { cwd: root });
      assert.equal(result.kind, 'ok');
      if (result.kind !== 'ok') return;
      assert.ok(result.metrics, 'expected a metrics object');
      assert.ok('circular-deps' in result.metrics);
      assert.equal(result.metrics['circular-deps']?.value, 2);
      assert.equal(result.metrics['circular-deps']?.direction, 'lower-is-better');
    });
  });

  it('returns kind "absent" when the ref is valid but the snapshot path does not exist there', async () => {
    await withBaselineGitFixture(async ({ root, noSnapshotSha }) => {
      const result = await loadBaselineSnapshotAt(noSnapshotSha, { cwd: root });
      assert.equal(result.kind, 'absent');
    });
  });

  it('returns kind "error" (not "absent") for a ref that does not exist at all', async () => {
    await withBaselineGitFixture(async ({ root }) => {
      const result = await loadBaselineSnapshotAt('no-such-ref-xyz', { cwd: root });
      assert.equal(
        result.kind,
        'error',
        `a garbage ref must fail loud, not silently skip like a missing path (got kind: ${result.kind})`,
      );
      if (result.kind !== 'error') return;
      assert.equal(typeof result.message, 'string');
      assert.ok(result.message.length > 0);
    });
  });
});

describe('snapshotShapeErrors (defect 2: a malformed snapshot must not read as "consistent")', () => {
  it('flags a snapshot missing the metrics key', () => {
    const errors = snapshotShapeErrors({});
    assert.ok(errors.length > 0, 'expected at least one error for a missing metrics key');
  });

  it('flags a snapshot whose metrics value is null', () => {
    const errors = snapshotShapeErrors({ metrics: null });
    assert.ok(errors.length > 0, 'expected at least one error for metrics: null');
  });

  it('flags a metric missing a numeric value, naming the offending key', () => {
    const errors = snapshotShapeErrors({
      metrics: { 'type-escapes': { direction: 'lower-is-better', unit: 'count', breakdown: null } },
    });
    assert.ok(errors.length > 0, 'expected at least one error for a metric with no value');
    assert.ok(
      errors.some((e: string) => e.includes('type-escapes')),
      `expected an error naming "type-escapes", got ${JSON.stringify(errors)}`,
    );
  });

  it('flags a metric whose value is not a number', () => {
    const errors = snapshotShapeErrors({
      metrics: { 'type-escapes': { direction: 'lower-is-better', value: 'five', unit: 'count', breakdown: null } },
    });
    assert.ok(errors.length > 0, 'expected at least one error for a non-numeric value');
    assert.ok(errors.some((e: string) => e.includes('type-escapes')));
  });

  it('returns no errors for a well-formed snapshot', () => {
    const errors = snapshotShapeErrors({
      metrics: {
        'circular-deps': { direction: 'lower-is-better', value: 2, unit: 'import cycles', breakdown: {} },
        'type-coverage': { direction: 'higher-is-better', value: 99.5, unit: 'percent', breakdown: null },
      },
    });
    assert.deepEqual(errors, []);
  });
});

describe('circular-deps detection (defect 3: tsconfig `paths` aliases must be resolved)', () => {
  it('flags a cycle formed entirely through a tsconfig path alias', async () => {
    await withFixture(
      {
        'packages/foo/tsconfig.json': JSON.stringify({
          compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/renderer/*'] } },
        }),
        'packages/foo/src/renderer/a.ts': `import { b } from '@/b';\nexport const a = 1;\nexport function useB() { return b; }\n`,
        'packages/foo/src/renderer/b.ts': `import { a } from '@/a';\nexport const b = 1;\nexport function useA() { return a; }\n`,
      },
      async (root) => {
        const result = await circularDeps.measure({ root });
        assert.ok(result.value >= 1, `expected an alias-mediated cycle to be detected, got ${result.value}`);
        const keys = Object.keys(result.breakdown ?? {});
        const key = keys.find((k) => k.includes('a.ts') && k.includes('b.ts'));
        assert.ok(key, `expected a breakdown key referencing both a.ts and b.ts, got ${JSON.stringify(keys)}`);
      },
    );
  });

  it('does not fabricate a cycle for a one-way alias reference', async () => {
    await withFixture(
      {
        'packages/foo/tsconfig.json': JSON.stringify({
          compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/renderer/*'] } },
        }),
        'packages/foo/src/renderer/a.ts': `import { b } from '@/b';\nexport const a = 1;\nexport function useB() { return b; }\n`,
        'packages/foo/src/renderer/b.ts': `export const b = 1;\n`,
      },
      async (root) => {
        const result = await circularDeps.measure({ root });
        assert.equal(result.value, 0, `expected 0 cycles for a one-way alias import, got ${result.value}`);
      },
    );
  });
});

describe('circular-deps detection (defect 4: dynamic import() must be followed)', () => {
  it('flags a cycle formed through a dynamic import()', async () => {
    await withFixture(
      {
        'packages/foo/src/a.ts': `export const load = () => import('./b.ts');\n`,
        'packages/foo/src/b.ts': `import { load } from './a.ts';\nexport function b() { return load; }\n`,
      },
      async (root) => {
        const result = await circularDeps.measure({ root });
        assert.ok(result.value >= 1, `expected a dynamic-import cycle to be detected, got ${result.value}`);
        const keys = Object.keys(result.breakdown ?? {});
        const key = keys.find((k) => k.includes('a.ts') && k.includes('b.ts'));
        assert.ok(key, `expected a breakdown key referencing both a.ts and b.ts, got ${JSON.stringify(keys)}`);
      },
    );
  });
});

describe('circular-deps detection (defect 5: import-shaped comments/strings must not create false edges)', () => {
  it('ignores import syntax inside a comment and a string literal', async () => {
    await withFixture(
      {
        'packages/foo/src/a.ts': `// import { x } from './b.ts'\nconst s = "import { y } from './b.ts'";\nexport const a = 1;\nexport const marker = s;\n`,
        'packages/foo/src/b.ts': `import { a } from './a.ts';\nexport function b() { return a; }\n`,
      },
      async (root) => {
        const result = await circularDeps.measure({ root });
        assert.equal(
          result.value,
          0,
          `comment/string text must not be parsed as an import edge, got ${result.value} cycle(s)`,
        );
      },
    );
  });
});
