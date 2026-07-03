// Guards the circular-deps ratchet's contract with the engine: the scalar
// `value` (count of import cycles) and the `breakdown` keys the gate diffs
// against must reflect real circular imports in production source under
// packages/*/src, with root-relative (not absolute) paths, and must not choke
// when a resolver style (extension vs. extensionless import) isn't the one it
// happens to prefer.
// Run with: node --test tools/ratchet/circular-deps.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import circularDeps from './adapters/circular-deps.ts';

async function withFixture(files: Record<string, string>, fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'ratchet-circular-deps-'));
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

describe('circular-deps contract', () => {
  it('id/direction/gate match the fields the engine relies on for gate semantics', () => {
    assert.equal(circularDeps.id, 'circular-deps');
    assert.equal(circularDeps.direction, 'lower-is-better');
    assert.equal(circularDeps.gate, 'total');
    assert.equal(typeof circularDeps.title, 'string');
    assert.ok(circularDeps.title.length > 0);
  });
});

describe('circular-deps detection', () => {
  it('flags two production files that import each other with explicit .ts extensions', async () => {
    await withFixture(
      {
        'packages/foo/src/a.ts': `import { b } from './b.ts';\nexport function a() { return b; }\nexport const b = 1;\n`,
        'packages/foo/src/b.ts': `import { a } from './a.ts';\nexport function b() { return a; }\nexport const a = 1;\n`,
      },
      async (root) => {
        const result = await circularDeps.measure({ root });
        assert.ok(result.value >= 1, `expected at least one cycle, got ${result.value}`);
        assert.ok(result.unit.includes('cycle'), `expected unit to mention "cycle", got ${result.unit}`);
        assert.ok(result.breakdown, 'expected a non-null breakdown for a detected cycle');
        const keys = Object.keys(result.breakdown!);
        assert.ok(keys.length > 0, 'expected at least one breakdown entry');
        const key = keys.find((k) => k.includes('a.ts') && k.includes('b.ts'));
        assert.ok(key, `expected a breakdown key referencing both a.ts and b.ts, got ${JSON.stringify(keys)}`);
        assert.ok(!key!.includes(root), `key must be relative to root, not absolute: ${key}`);
        assert.ok(!key!.startsWith(sep), `key must not start with a path separator: ${key}`);
      },
    );
  });

  it('flags two production files that import each other without an extension', async () => {
    await withFixture(
      {
        'packages/foo/src/a.ts': `import { b } from './b';\nexport function a() { return b; }\nexport const b = 1;\n`,
        'packages/foo/src/b.ts': `import { a } from './a';\nexport function b() { return a; }\nexport const a = 1;\n`,
      },
      async (root) => {
        const result = await circularDeps.measure({ root });
        assert.ok(result.value >= 1, `expected at least one cycle for extensionless imports, got ${result.value}`);
        assert.ok(result.breakdown, 'expected a non-null breakdown for a detected cycle');
        const keys = Object.keys(result.breakdown!);
        const key = keys.find((k) => k.includes('a.ts') && k.includes('b.ts'));
        assert.ok(key, `expected a breakdown key referencing both a.ts and b.ts, got ${JSON.stringify(keys)}`);
        assert.ok(!key!.includes(root), `key must be relative to root, not absolute: ${key}`);
      },
    );
  });

  it('two files with a one-way import report zero cycles', async () => {
    await withFixture(
      {
        'packages/foo/src/a.ts': `import { b } from './b.ts';\nexport function a() { return b; }\n`,
        'packages/foo/src/b.ts': `export const b = 1;\n`,
      },
      async (root) => {
        const result = await circularDeps.measure({ root });
        assert.equal(result.value, 0, `expected 0 cycles for a one-way import, got ${result.value}`);
      },
    );
  });

  it('reports zero cycles without throwing when no packages directory exists', async () => {
    await withFixture({ 'README.md': 'no packages here\n' }, async (root) => {
      const result = await circularDeps.measure({ root });
      assert.equal(result.value, 0);
    });
  });

  it('does not count a cycle formed only between .test.ts files', async () => {
    await withFixture(
      {
        'packages/foo/src/a.test.ts': `import { b } from './b.test.ts';\nexport function a() { return b; }\nexport const b = 1;\n`,
        'packages/foo/src/b.test.ts': `import { a } from './a.test.ts';\nexport function b() { return a; }\nexport const a = 1;\n`,
      },
      async (root) => {
        const result = await circularDeps.measure({ root });
        assert.equal(result.value, 0, `expected test-only cycles to be ignored, got ${result.value}`);
      },
    );
  });
});
