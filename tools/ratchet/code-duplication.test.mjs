// Guards the code-duplication ratchet's contract with the engine: the scalar
// `value` it reports (total duplicated lines) and the `breakdown` keys the gate
// diffs against must actually reflect real copy-paste, scoped to production
// source under packages/*/src, with test/declaration noise excluded.
// Run with: node --test tools/ratchet/code-duplication.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import codeDuplication from './adapters/code-duplication.mjs';

// A real, sizable function body — well over jscpd's ~50-token default
// threshold — so a verbatim copy is unambiguously flagged as a clone rather
// than sitting near the detection boundary.
const DUP_BLOCK = `function computeTotal(items) {
  let total = 0;
  let count = 0;
  let discount = 0;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    total += item.price;
    count += 1;
    if (item.onSale) {
      discount += item.price * 0.1;
    }
    if (item.taxable) {
      total += item.price * 0.08;
    }
    console.log('processing', item.id, total);
  }
  total -= discount;
  return { total, count, discount };
}`;

async function withFixture(files, fn) {
  const root = await mkdtemp(join(tmpdir(), 'ratchet-code-dup-'));
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

test('contract: id/direction/gate match the fields the engine relies on for gate semantics', () => {
  assert.equal(codeDuplication.id, 'code-duplication');
  assert.equal(codeDuplication.direction, 'lower-is-better');
  assert.equal(codeDuplication.gate, 'total');
  assert.equal(typeof codeDuplication.title, 'string');
  assert.ok(codeDuplication.title.length > 0);
});

test('two production files sharing a large block are flagged as one clone', async () => {
  await withFixture(
    {
      'packages/foo/src/orderA.ts': `export type Item = { id: string; price: number; onSale: boolean; taxable: boolean };\n\n${DUP_BLOCK}\n\nexport function summarizeOrderA(items: Item[]) {\n  return computeTotal(items);\n}\n`,
      'packages/foo/src/orderB.ts': `export type OtherItem = { id: string; price: number; onSale: boolean; taxable: boolean };\n\n${DUP_BLOCK}\n\nexport function summarizeOrderB(items: OtherItem[]) {\n  return computeTotal(items);\n}\n`,
    },
    async (root) => {
      const result = await codeDuplication.measure({ root });
      assert.ok(result.value > 0, `expected duplicated lines > 0, got ${result.value}`);
      assert.ok(result.breakdown, 'expected a non-null breakdown for a detected clone');
      const keys = Object.keys(result.breakdown);
      assert.equal(keys.length, 1, `expected exactly one clone pair, got ${JSON.stringify(keys)}`);
      const [key] = keys;
      assert.ok(key.includes('orderA.ts'), `key should reference orderA.ts, got ${key}`);
      assert.ok(key.includes('orderB.ts'), `key should reference orderB.ts, got ${key}`);
      assert.ok(!key.includes(root), `key must be relative to root, not absolute: ${key}`);
      assert.ok(!key.startsWith(sep), `key must not start with a path separator: ${key}`);
    },
  );
});

test('a block duplicated between a .test.ts fixture and a production file is not counted', async () => {
  // Guards against test-fixture noise inflating production duplication: a test
  // file legitimately re-declaring a helper for its own assertions must not
  // make the ratchet think production code duplicated itself.
  await withFixture(
    {
      'packages/foo/src/order.ts': `export type Item = { id: string; price: number; onSale: boolean; taxable: boolean };\n\n${DUP_BLOCK}\n`,
      'packages/foo/src/order.test.ts': `${DUP_BLOCK}\n\ntest('computeTotal works', () => {});\n`,
    },
    async (root) => {
      const result = await codeDuplication.measure({ root });
      assert.equal(result.value, 0, `expected 0 duplicated lines when the only match is in a .test.ts file, got ${result.value}`);
    },
  );
});

test('a block duplicated inside a .d.ts declaration file is not counted', async () => {
  await withFixture(
    {
      'packages/foo/src/order.ts': `export type Item = { id: string; price: number; onSale: boolean; taxable: boolean };\n\n${DUP_BLOCK}\n`,
      'packages/foo/src/types.d.ts': `${DUP_BLOCK}\n`,
    },
    async (root) => {
      const result = await codeDuplication.measure({ root });
      assert.equal(result.value, 0, `expected 0 duplicated lines when the only match is in a .d.ts file, got ${result.value}`);
    },
  );
});

test('duplicates inside node_modules/build/generated dirs under src are not counted', async () => {
  // Guards against vendored deps and build/codegen output inflating production
  // duplication: generated or third-party copies of a source block are not
  // production copy-paste and must not move the ratchet.
  await withFixture(
    {
      'packages/foo/src/a.ts': `export type Item = { id: string; price: number; onSale: boolean; taxable: boolean };\n\n${DUP_BLOCK}\n`,
      'packages/foo/src/node_modules/dep/b.ts': `${DUP_BLOCK}\n`,
      'packages/foo/src/build/c.ts': `${DUP_BLOCK}\n`,
      'packages/foo/src/generated/d.ts': `${DUP_BLOCK}\n`,
    },
    async (root) => {
      const result = await codeDuplication.measure({ root });
      assert.equal(result.value, 0, `expected 0 duplicated lines when copies live only in node_modules/build/generated, got ${result.value} (breakdown: ${JSON.stringify(result.breakdown)})`);
    },
  );
});

test('two genuinely different production files report zero duplication', async () => {
  await withFixture(
    {
      'packages/foo/src/alpha.ts': `export function greet(name: string) {\n  const trimmed = name.trim();\n  if (trimmed.length === 0) {\n    return 'hello, stranger';\n  }\n  return \`hello, \${trimmed}\`;\n}\n\nexport function farewell(name: string) {\n  return \`goodbye, \${name}\`;\n}\n`,
      'packages/foo/src/beta.ts': `export class Counter {\n  private value = 0;\n\n  increment(step: number) {\n    this.value += step;\n    return this.value;\n  }\n\n  reset() {\n    this.value = 0;\n  }\n}\n`,
    },
    async (root) => {
      const result = await codeDuplication.measure({ root });
      assert.equal(result.value, 0, `expected 0 duplicated lines for genuinely different files, got ${result.value}`);
      if (result.breakdown) {
        assert.equal(Object.keys(result.breakdown).length, 0, `expected no breakdown entries, got ${JSON.stringify(result.breakdown)}`);
      }
    },
  );
});
