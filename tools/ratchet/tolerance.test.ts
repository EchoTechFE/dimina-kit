// Guards per-dimension tolerance: a dimension may declare an absolute
// tolerance (same unit as its value) so a small drop that's still within
// tolerance of the baseline does not count as a regression. Covers the three
// call sites tolerance must reach — regressionsOf (total + per-key-value
// gates, both directions), measureAll (adapter → Metric passthrough), and
// baselineGuardViolations (anti-tamper compare) — plus the test-coverage
// adapter, the first declared user of a ±1-point tolerance. A dimension that
// never declares tolerance must keep comparing strictly; that's pinned
// separately from the tolerant cases so a looser default can't sneak in.
// Run with: node --test tools/ratchet/tolerance.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { regressionsOf, measureAll, baselineGuardViolations } from './ratchet.ts';
import type { Adapter, Direction, GateMode, Metric, MetricGuardInput } from './ratchet.ts';
import testCoverageAdapter from './adapters/test-coverage.ts';

// regressionsOf's first argument type doesn't declare `tolerance` yet; this
// local shape carries it so the object can be built through a variable
// (never inlined at the call site) and stay assignable — extra properties on
// a non-fresh value don't trip TS's excess-property check.
type ToleratedAdapterShape = { direction: Direction; gate?: GateMode; tolerance?: number };

describe('regressionsOf tolerance — total, higher-is-better', () => {
  const a: ToleratedAdapterShape = { direction: 'higher-is-better', tolerance: 1 };

  it('does not flag a drop within tolerance as a regression', () => {
    const out = regressionsOf(a, { value: 90 }, { value: 89.2 });
    assert.deepEqual(out, []);
  });

  it('flags a drop past tolerance as a regression', () => {
    const out = regressionsOf(a, { value: 90 }, { value: 88 });
    assert.deepEqual(out, ['total 90 → 88']);
  });

  it('treats cur exactly at base - tolerance as the boundary, not a regression', () => {
    const out = regressionsOf(a, { value: 90 }, { value: 89 });
    assert.deepEqual(out, []);
  });
});

describe('regressionsOf tolerance — total, lower-is-better', () => {
  const a: ToleratedAdapterShape = { direction: 'lower-is-better', tolerance: 2 };

  it('does not flag a rise within tolerance as a regression', () => {
    const out = regressionsOf(a, { value: 10 }, { value: 11.5 });
    assert.deepEqual(out, []);
  });

  it('flags a rise past tolerance as a regression', () => {
    const out = regressionsOf(a, { value: 10 }, { value: 13 });
    assert.deepEqual(out, ['total 10 → 13']);
  });

  it('treats cur exactly at base + tolerance as the boundary, not a regression', () => {
    const out = regressionsOf(a, { value: 10 }, { value: 12 });
    assert.deepEqual(out, []);
  });
});

describe('regressionsOf tolerance — per-key-value gate', () => {
  const a: ToleratedAdapterShape = { direction: 'higher-is-better', gate: 'per-key-value', tolerance: 1 };
  const base = { value: 170, breakdown: { pkgA: 90, pkgB: 80 } };

  it('does not flag a per-key drop within tolerance', () => {
    const out = regressionsOf(a, base, { value: 169.5, breakdown: { pkgA: 89.5, pkgB: 80 } });
    assert.deepEqual(out, []);
  });

  it('flags a per-key drop past tolerance even when the total stays within tolerance', () => {
    const out = regressionsOf(a, base, { value: 169.5, breakdown: { pkgA: 88, pkgB: 80 } });
    assert.deepEqual(out, ['pkgA  90 → 88']);
  });
});

describe('regressionsOf without a declared tolerance stays strict', () => {
  it('flags any drop, pinning current strict behavior against a looser default', () => {
    const a: ToleratedAdapterShape = { direction: 'higher-is-better' };
    const out = regressionsOf(a, { value: 90 }, { value: 89.9 });
    assert.deepEqual(out, ['total 90 → 89.9']);
  });
});

describe('measureAll tolerance passthrough', () => {
  type FakeAdapter = Adapter & { tolerance?: number };

  it('copies the adapter-declared tolerance onto the produced metric', async () => {
    const a: FakeAdapter = {
      id: 'a',
      title: 'A',
      direction: 'higher-is-better',
      tolerance: 5,
      measure: async () => ({ value: 10 }),
    };
    const metrics = await measureAll([a]);
    const got: Metric & { tolerance?: number } = metrics.a;
    assert.equal(got.tolerance, 5);
  });

  it('leaves tolerance undefined when the adapter does not declare one', async () => {
    const b: FakeAdapter = {
      id: 'b',
      title: 'B',
      direction: 'higher-is-better',
      measure: async () => ({ value: 10 }),
    };
    const metrics = await measureAll([b]);
    const got: Metric & { tolerance?: number } = metrics.b;
    assert.equal(got.tolerance, undefined);
  });
});

describe('baselineGuardViolations tolerance', () => {
  type GuardMetric = MetricGuardInput & { tolerance?: number };

  it('does not flag a within-tolerance drop when the base metric declares tolerance', () => {
    const base: GuardMetric = { direction: 'higher-is-better', value: 98, tolerance: 1 };
    const baseMetrics = { 'test-coverage': base };
    const prMetrics: Record<string, MetricGuardInput> = { 'test-coverage': { direction: 'higher-is-better', value: 97.5 } };
    const { violations } = baselineGuardViolations(baseMetrics, prMetrics);
    assert.deepEqual(violations, []);
  });

  it('flags a drop past the base metric tolerance', () => {
    const base: GuardMetric = { direction: 'higher-is-better', value: 98, tolerance: 1 };
    const baseMetrics = { 'test-coverage': base };
    const prMetrics: Record<string, MetricGuardInput> = { 'test-coverage': { direction: 'higher-is-better', value: 96 } };
    const { violations } = baselineGuardViolations(baseMetrics, prMetrics);
    assert.equal(violations.length, 1);
    assert.ok(violations[0].includes('test-coverage'));
  });

  it('stays strict when the base metric has no tolerance, pinning current behavior', () => {
    const baseMetrics: Record<string, MetricGuardInput> = { 'test-coverage': { direction: 'higher-is-better', value: 98 } };
    const prMetrics: Record<string, MetricGuardInput> = { 'test-coverage': { direction: 'higher-is-better', value: 97.9 } };
    const { violations } = baselineGuardViolations(baseMetrics, prMetrics);
    assert.equal(violations.length, 1);
  });
});

describe('test-coverage adapter', () => {
  it('declares a 1 percentage-point tolerance', () => {
    const adapter: Adapter & { tolerance?: number } = testCoverageAdapter;
    assert.equal(adapter.tolerance, 1);
  });
});
