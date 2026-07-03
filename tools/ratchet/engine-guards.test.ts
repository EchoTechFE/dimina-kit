// Guards four engine-level contracts that don't belong to any single adapter:
//   - orphanedMetrics: a deleted adapter must not silently drop its gate.
//   - baselineGuardViolations: snapshot.json can't be hand-edited to fake a pass.
//   - improvementNotice: an unrecorded improvement must surface on CI, not just
//     locally where a developer might miss the `diff` output.
//   - measureAll: adapter measurements run concurrently, not serially, so a slow
//     adapter (e.g. jscpd) doesn't block every other adapter behind it.
// Run with: node --test tools/ratchet/engine-guards.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { orphanedMetrics, baselineGuardViolations, improvementNotice, measureAll } from './ratchet.ts';

type Direction = 'lower-is-better' | 'higher-is-better';
type Metric = {
  direction: Direction;
  value: number;
  unit?: string;
  breakdown?: Record<string, number> | null;
};

function metric(direction: Direction, value: number): Metric {
  return { direction, value, unit: 'count', breakdown: null };
}

describe('orphanedMetrics', () => {
  it('flags a baseline metric whose adapter file was deleted', () => {
    const out = orphanedMetrics(['a'], { a: metric('lower-is-better', 1), b: metric('lower-is-better', 2), c: metric('lower-is-better', 3) });
    assert.deepEqual(out, ['b', 'c']);
  });

  it('returns an empty list when every baseline metric still has an adapter', () => {
    const out = orphanedMetrics(['a', 'b'], { a: metric('lower-is-better', 1), b: metric('lower-is-better', 2) });
    assert.deepEqual(out, []);
  });

  it('returns an empty list for an empty baseline', () => {
    const out = orphanedMetrics(['a', 'b'], {});
    assert.deepEqual(out, []);
  });

  it('does not treat a brand-new adapter (not yet recorded) as an orphan', () => {
    const out = orphanedMetrics(['a', 'b'], { a: metric('lower-is-better', 1) });
    assert.deepEqual(out, []);
  });
});

describe('baselineGuardViolations', () => {
  it('catches a hand-edited baseline: lower-is-better value raised', () => {
    const base = { 'type-escapes': metric('lower-is-better', 5) };
    const pr = { 'type-escapes': metric('lower-is-better', 50) };
    const { violations, removed } = baselineGuardViolations(base, pr);
    assert.equal(removed.length, 0);
    assert.equal(violations.length, 1);
    assert.ok(violations[0].includes('type-escapes'));
    assert.ok(violations[0].includes('5'));
    assert.ok(violations[0].includes('50'));
  });

  it('catches a hand-edited baseline: higher-is-better value lowered', () => {
    const base = { 'type-coverage': metric('higher-is-better', 99.5) };
    const pr = { 'type-coverage': metric('higher-is-better', 10) };
    const { violations } = baselineGuardViolations(base, pr);
    assert.equal(violations.length, 1);
    assert.ok(violations[0].includes('type-coverage'));
    assert.ok(violations[0].includes('99.5'));
    assert.ok(violations[0].includes('10'));
  });

  it('does not flag a genuine improvement', () => {
    const base = { 'type-escapes': metric('lower-is-better', 5) };
    const pr = { 'type-escapes': metric('lower-is-better', 1) };
    const { violations, removed } = baselineGuardViolations(base, pr);
    assert.deepEqual(violations, []);
    assert.deepEqual(removed, []);
  });

  it('does not flag an unchanged value', () => {
    const base = { 'type-escapes': metric('lower-is-better', 5) };
    const pr = { 'type-escapes': metric('lower-is-better', 5) };
    const { violations, removed } = baselineGuardViolations(base, pr);
    assert.deepEqual(violations, []);
    assert.deepEqual(removed, []);
  });

  it('flags a baseline metric missing from the PR snapshot as removed, not a violation', () => {
    const base = { 'code-duplication': metric('lower-is-better', 625) };
    const pr = {};
    const { violations, removed } = baselineGuardViolations(base, pr);
    assert.deepEqual(violations, []);
    assert.deepEqual(removed, ['code-duplication']);
  });

  it('ignores a metric present only on the PR side (a legitimate new adapter)', () => {
    const base = {};
    const pr = { 'circular-deps': metric('lower-is-better', 0) };
    const { violations, removed } = baselineGuardViolations(base, pr);
    assert.deepEqual(violations, []);
    assert.deepEqual(removed, []);
  });

  it('defaults to lower-is-better when direction is missing', () => {
    const base = { mystery: { value: 5, unit: 'count', breakdown: null } as unknown as Metric };
    const worsePr = { mystery: { value: 50, unit: 'count', breakdown: null } as unknown as Metric };
    const { violations: worseViolations } = baselineGuardViolations(base, worsePr);
    assert.equal(worseViolations.length, 1);

    const betterPr = { mystery: { value: 1, unit: 'count', breakdown: null } as unknown as Metric };
    const { violations: betterViolations } = baselineGuardViolations(base, betterPr);
    assert.deepEqual(betterViolations, []);
  });
});

describe('improvementNotice', () => {
  it('emits a CI notice naming every improved dimension', () => {
    const notice = improvementNotice(['type-escapes', 'file-length'], true);
    assert.ok(notice, 'expected a non-null notice');
    assert.ok(notice!.startsWith('::notice'));
    assert.ok(notice!.includes('type-escapes'));
    assert.ok(notice!.includes('file-length'));
    assert.ok(notice!.includes('ratchet:record'));
    assert.equal(notice!.includes('\n'), false, 'expected a single line');
  });

  it('returns null when nothing improved', () => {
    assert.equal(improvementNotice([], true), null);
  });

  it('returns null outside CI even when something improved', () => {
    assert.equal(improvementNotice(['type-escapes'], false), null);
  });
});

describe('measureAll', () => {
  function createDeferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  it('starts every adapter measurement before any of them resolves', async () => {
    const first = createDeferred<{ value: number }>();
    const second = createDeferred<{ value: number; unit: string; breakdown: Record<string, number> }>();
    const calls: string[] = [];

    const adapterA = {
      id: 'a',
      title: 'Adapter A',
      direction: 'lower-is-better' as const,
      measure: () => {
        calls.push('a');
        return first.promise;
      },
    };
    const adapterB = {
      id: 'b',
      title: 'Adapter B',
      direction: 'higher-is-better' as const,
      measure: () => {
        calls.push('b');
        return second.promise;
      },
    };

    const resultPromise = measureAll([adapterA, adapterB]);

    // Both adapters must already have been invoked even though neither promise
    // has resolved yet — a serial for-await would only have called adapter A.
    assert.deepEqual(calls, ['a', 'b']);

    first.resolve({ value: 1 });
    second.resolve({ value: 2, unit: 'cycles', breakdown: { x: 1 } });
    const result = await resultPromise;

    assert.deepEqual(result.a, { direction: 'lower-is-better', value: 1, unit: 'count', breakdown: null });
    assert.deepEqual(result.b, { direction: 'higher-is-better', value: 2, unit: 'cycles', breakdown: { x: 1 } });
  });
});
