// Guards the gate's regression detection — especially that a localized regression
// cannot hide behind an unchanged scalar total (the failure mode a plain total
// ratchet has). Run with: node --test tools/ratchet/gate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { regressionsOf } from './ratchet.mjs';

const lower = (gate) => ({ direction: 'lower-is-better', gate });
const higher = (gate) => ({ direction: 'higher-is-better', gate });

test('per-file-count: net-zero swap across files is still caught', () => {
  // total stays 2, but b.ts gained an escape while a.ts shed one.
  const base = { value: 2, breakdown: { 'a.ts:10 (any)': 1, 'b.ts:5 (any)': 1 } };
  const cur = { value: 2, breakdown: { 'b.ts:5 (any)': 1, 'b.ts:9 (any)': 1 } };
  const out = regressionsOf(lower('per-file-count'), base, cur);
  assert.ok(out.some((l) => l.startsWith('b.ts')), `expected b.ts regression, got ${JSON.stringify(out)}`);
});

test('per-file-count: moving an escape within a file is NOT a regression', () => {
  const base = { value: 1, breakdown: { 'a.ts:10 (any)': 1 } };
  const cur = { value: 1, breakdown: { 'a.ts:42 (any)': 1 } };
  assert.deepEqual(regressionsOf(lower('per-file-count'), base, cur), []);
});

test('per-file-count: removing an escape is an improvement, not a regression', () => {
  const base = { value: 2, breakdown: { 'a.ts:10 (any)': 1, 'a.ts:11 (any)': 1 } };
  const cur = { value: 1, breakdown: { 'a.ts:10 (any)': 1 } };
  assert.deepEqual(regressionsOf(lower('per-file-count'), base, cur), []);
});

test('per-key-value: one package dropping is caught even if overall holds', () => {
  const base = { value: 99.6, breakdown: { devtools: 99.5, devkit: 99.9 } };
  const cur = { value: 99.6, breakdown: { devtools: 99.2, devkit: 100 } };
  const out = regressionsOf(higher('per-key-value'), base, cur);
  assert.ok(out.some((l) => l.startsWith('devtools')), `expected devtools regression, got ${JSON.stringify(out)}`);
});

test('total: only the scalar matters', () => {
  const base = { value: 58, breakdown: { 'big.ts': 600 } };
  const grew = { value: 58, breakdown: { 'big.ts': 900 } }; // already-long file grew
  assert.deepEqual(regressionsOf(lower('total'), base, grew), []);
  const crossed = { value: 59, breakdown: { 'big.ts': 900, 'new.ts': 501 } };
  assert.ok(regressionsOf(lower('total'), base, crossed).length > 0);
});
