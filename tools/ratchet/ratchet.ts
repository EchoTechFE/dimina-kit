#!/usr/bin/env node
// Tool-agnostic anti-regression ratchet.
//
// Each adapter under ./adapters measures ONE quality dimension and returns a
// numeric value plus an optional per-file breakdown. The engine snapshots those
// values to ./snapshot.json; `check` re-measures and fails when any dimension
// regresses against the snapshot. The underlying tool is an implementation
// detail of the adapter — swapping eslint→oxlint, or replacing one linter with
// another, means rewriting a single adapter while the recorded baseline and the
// CI gate stay put.
//
// Commands:
//   record          measure every dimension and (over)write the snapshot — use
//                    this to establish the baseline and to lock in improvements
//                    after cleanup.
//   check           measure and compare against the snapshot; exit 1 if
//                    anything got worse. This is the CI gate.
//   diff            measure and compare, print the table, always exit 0. This
//                    answers "how far did this cleanup move the numbers"
//                    without gating.
//   baseline-guard <ref>
//                    compare the working tree's snapshot.json against the
//                    version committed at <ref> (typically the PR base branch)
//                    — catches a hand-edited snapshot.json that fakes a pass
//                    without the underlying metric actually improving.

import { spawn } from 'node:child_process';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Adapter, Direction, GateMode, MeasureResult, Metric, Snapshot } from './lib/types.ts';

export type { Adapter, Direction, GateMode, MeasureResult, Metric, Snapshot };

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const ADAPTERS_DIR = join(HERE, 'adapters');
const SNAPSHOT = join(HERE, 'snapshot.json');
const SNAPSHOT_REPO_PATH = 'tools/ratchet/snapshot.json';

async function loadAdapters(): Promise<Adapter[]> {
  const files = (await readdir(ADAPTERS_DIR))
    .filter((f) => f.endsWith('.ts'))
    .sort();
  const adapters: Adapter[] = [];
  for (const f of files) {
    const mod = (await import(pathToFileURL(join(ADAPTERS_DIR, f)).href)) as { default: Adapter };
    adapters.push(mod.default);
  }
  return adapters;
}

// Measures every adapter concurrently — a slow adapter (e.g. jscpd) must not
// block every other adapter behind it in a serial for-await. Each `measure()`
// call is started (and its progress line printed) before any of them are
// awaited; Promise.all then waits on the whole batch.
export async function measureAll(adapters: Adapter[]): Promise<Record<string, Metric>> {
  const inFlight = adapters.map((a) => {
    process.stderr.write(`  measuring ${a.id}…\n`);
    return a.measure().then((r: MeasureResult): [string, Metric] => [
      a.id,
      {
        direction: a.direction,
        value: r.value,
        unit: r.unit ?? 'count',
        breakdown: r.breakdown ?? null,
      },
    ]);
  });
  const settled = await Promise.all(inFlight);
  const metrics: Record<string, Metric> = {};
  for (const [id, metric] of settled) metrics[id] = metric;
  return metrics;
}

function worse(direction: Direction, base: number, cur: number): boolean {
  return direction === 'higher-is-better' ? cur < base : cur > base;
}
function better(direction: Direction, base: number, cur: number): boolean {
  return direction === 'higher-is-better' ? cur > base : cur < base;
}

// Offender count per file from a `path:line …`-keyed breakdown. Counting keys
// (not summing their values) makes the gate robust to code moving lines around:
// the same file keeps the same offender count even as line numbers shift.
function offenderCountsByFile(breakdown: Record<string, number> | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of Object.keys(breakdown ?? {})) {
    const f = k.split(':')[0] ?? k;
    out[f] = (out[f] ?? 0) + 1;
  }
  return out;
}

// Only the fields a regression check needs — narrower than the full Metric
// shape so callers (notably tests) can pass bare { value, breakdown } samples
// without also supplying direction/unit, which regressionsOf never reads off
// the sample itself (direction comes from the adapter, not the metric).
export type MetricSample = { value: number; breakdown?: Record<string, number> | null };

// The subset of a Metric that orphan/baseline-guard checks actually read.
// Looser than the engine's own Metric (unit isn't examined at all, and
// direction is optional so a metric missing it — a hand-crafted or corrupted
// snapshot — still type-checks and falls back to lower-is-better at runtime).
export type MetricGuardInput = {
  direction?: Direction;
  value: number;
  unit?: string;
  breakdown?: Record<string, number> | null;
};

// Regression detail for one dimension, honoring its `gate` mode. Returns
// human-readable lines (empty = no regression). The scalar total is always
// checked; the per-file / per-key check on top of it stops a localized
// regression from hiding behind a net-zero total (file A improves, file B
// worsens, total unchanged).
//   total          — scalar only (e.g. file-length: count of files over a limit)
//   per-file-count — offender count per file may not rise (type-escapes, cognitive)
//   per-key-value  — each key's value may not worsen (type-coverage: per-package %)
export function regressionsOf(
  a: { direction: Direction; gate?: GateMode },
  base: MetricSample,
  cur: MetricSample,
): string[] {
  const out: string[] = [];
  if (worse(a.direction, base.value, cur.value)) {
    out.push(`total ${base.value} → ${cur.value}`);
  }
  const mode = a.gate ?? 'total';
  if (mode === 'per-file-count') {
    const b = offenderCountsByFile(base.breakdown);
    const c = offenderCountsByFile(cur.breakdown);
    for (const f of [...new Set([...Object.keys(b), ...Object.keys(c)])].sort()) {
      const bn = b[f] ?? 0;
      const cn = c[f] ?? 0;
      if (cn > bn) out.push(`${f}  ${bn} → ${cn}`);
    }
  } else if (mode === 'per-key-value') {
    const b = base.breakdown ?? {};
    const c = cur.breakdown ?? {};
    for (const k of Object.keys(b).sort()) {
      const cv = c[k];
      if (cv !== undefined && worse(a.direction, b[k] ?? 0, cv)) out.push(`${k}  ${b[k]} → ${cv}`);
    }
  }
  return out;
}

// Baseline metrics with no corresponding adapter left. Deleting an adapter
// file must not silently drop its gate — the dimension has to be explicitly
// removed from the snapshot (re-`record`) so a regression can't hide behind a
// vanished measurement.
export function orphanedMetrics(adapterIds: string[], baselineMetrics: Record<string, MetricGuardInput>): string[] {
  const ids = new Set(adapterIds);
  return Object.keys(baselineMetrics)
    .filter((id) => !ids.has(id))
    .sort();
}

// Pure comparison between two snapshots' metrics (no filesystem/git access),
// so both the engine's `check` gate and the `baseline-guard` CLI subcommand
// share one judgment of "did this get worse". A metric present in `base` but
// missing from `pr` is reported as `removed`, not a violation — deleting an
// adapter is legitimate as long as it also drops the dimension from the
// snapshot (see orphanedMetrics). A metric missing `direction` (a
// hand-crafted or corrupted snapshot) defaults to lower-is-better, the more
// conservative reading.
export function baselineGuardViolations(
  baseMetrics: Record<string, MetricGuardInput>,
  prMetrics: Record<string, MetricGuardInput>,
): { violations: string[]; removed: string[] } {
  const violations: string[] = [];
  const removed: string[] = [];
  for (const id of Object.keys(baseMetrics)) {
    const base = baseMetrics[id];
    const pr = prMetrics[id];
    if (base === undefined) continue;
    if (pr === undefined) {
      removed.push(id);
      continue;
    }
    const direction: Direction = base.direction ?? 'lower-is-better';
    if (worse(direction, base.value, pr.value)) {
      violations.push(`${id}: ${base.value} → ${pr.value}`);
    }
  }
  return { violations, removed };
}

// A single-line CI annotation naming every dimension that improved since the
// snapshot, so a developer who only looked at `check`'s exit code (and not
// the `diff` table) still finds out an improvement is sitting unrecorded.
export function improvementNotice(improvedIds: string[], onCi: boolean): string | null {
  if (!onCi || improvedIds.length === 0) return null;
  return `::notice::ratchet improved: ${improvedIds.join(', ')} — run \`pnpm ratchet:record\` to lock in the gains.`;
}

function fmtDelta(base: number | null, cur: number): string {
  if (base === null) return 'new';
  const d = Math.round((cur - base) * 100) / 100;
  if (d === 0) return '±0';
  return d > 0 ? `+${d}` : `${d}`;
}

function statusOf(direction: Direction, base: number | null, cur: number): string {
  if (base === null) return '🆕 new';
  if (worse(direction, base, cur)) return '❌ worse';
  if (better(direction, base, cur)) return '🎉 better';
  return '✅ same';
}

function printTable(
  adapters: Adapter[],
  baseline: Snapshot | null,
  current: Record<string, Metric>,
  regressedIds: Set<string> = new Set(),
): void {
  const rows = adapters.map((a) => {
    const base = baseline?.metrics?.[a.id]?.value ?? null;
    const cur = current[a.id]?.value ?? 0;
    return {
      id: a.id,
      title: a.title,
      unit: current[a.id]?.unit,
      base,
      cur,
      delta: fmtDelta(base, cur),
      // A per-file/per-key regression can leave the scalar unchanged, so let the
      // gate's verdict override the scalar-only status.
      status: regressedIds.has(a.id) ? '❌ worse' : statusOf(a.direction, base, cur),
    };
  });
  const w = (s: unknown) => String(s ?? '—');
  const pad = (s: unknown, n: number) => w(s).padEnd(n);
  const padL = (s: unknown, n: number) => w(s).padStart(n);
  const idW = Math.max(6, ...rows.map((r) => r.id.length));
  console.log('');
  console.log(
    `${pad('metric', idW)}  ${padL('baseline', 9)}  ${padL('current', 9)}  ${padL('Δ', 6)}  status`,
  );
  console.log('-'.repeat(idW + 9 + 9 + 6 + 12));
  for (const r of rows) {
    console.log(
      `${pad(r.id, idW)}  ${padL(r.base, 9)}  ${padL(r.cur, 9)}  ${padL(r.delta, 6)}  ${r.status}`,
    );
  }
  console.log('');
}

async function readSnapshot(): Promise<Snapshot | null> {
  if (!existsSync(SNAPSHOT)) return null;
  return JSON.parse(await readFile(SNAPSHOT, 'utf8')) as Snapshot;
}

function runGit(args: string[], cwd: string = ROOT): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d));
    child.stderr.on('data', (d: Buffer) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

// Three ways a baseline lookup at `ref` can go: a real snapshot ("ok"), a ref
// that resolves fine but simply predates the snapshot file ("absent" — the
// legitimate skip case), or git itself failing to resolve `ref` at all
// ("error" — a typo'd ref, a shallow clone missing the commit, a corrupt
// repo). baseline-guard must only treat "absent" as a free pass; collapsing
// "error" into the same bucket would let a bad ref silently disable the
// anti-tamper gate.
export type BaselineSnapshotResult =
  | { kind: 'ok'; metrics: Record<string, Metric> }
  | { kind: 'absent' }
  | { kind: 'error'; message: string };

export async function loadBaselineSnapshotAt(
  ref: string,
  opts: { cwd?: string } = {},
): Promise<BaselineSnapshotResult> {
  const cwd = opts.cwd ?? ROOT;
  // `git rev-parse --verify` first, separately from `git show`: it fails only
  // when `ref` itself doesn't resolve, so its exit code is the one honest
  // signal for "error". `git show <ref>:<path>` fails both for a bad ref AND
  // for a valid ref missing the path — conflating those is exactly the bug
  // this function exists to avoid.
  const verify = await runGit(['rev-parse', '--verify', ref], cwd);
  if (verify.code !== 0) {
    return { kind: 'error', message: verify.stderr.trim() || `git could not resolve ref "${ref}"` };
  }
  const show = await runGit(['show', `${ref}:${SNAPSHOT_REPO_PATH}`], cwd);
  if (show.code !== 0) {
    return { kind: 'absent' };
  }
  try {
    const parsed = JSON.parse(show.stdout) as { metrics?: Record<string, Metric> };
    return { kind: 'ok', metrics: parsed.metrics ?? {} };
  } catch {
    return { kind: 'error', message: `snapshot.json at ${ref} is not valid JSON` };
  }
}

// A shape guard run before a parsed snapshot.json is trusted for comparison —
// JSON.parse succeeding only proves the file is valid JSON, not that it still
// has the metrics shape the gate needs. A hand-corrupted or truncated
// snapshot (missing metrics, a metric with no numeric value, …) must not read
// as "consistent" for free.
export function snapshotShapeErrors(parsed: unknown): string[] {
  const errors: string[] = [];
  if (typeof parsed !== 'object' || parsed === null) {
    errors.push('snapshot is not an object');
    return errors;
  }
  const metrics = (parsed as { metrics?: unknown }).metrics;
  if (typeof metrics !== 'object' || metrics === null) {
    errors.push('snapshot.metrics is missing or not an object');
    return errors;
  }
  const entries = Object.entries(metrics as Record<string, unknown>);
  if (entries.length === 0) {
    errors.push('snapshot.metrics is empty');
    return errors;
  }
  for (const [key, value] of entries) {
    if (typeof value !== 'object' || value === null) {
      errors.push(`metric "${key}" is not an object`);
      continue;
    }
    const v = (value as { value?: unknown }).value;
    if (typeof v !== 'number' || Number.isNaN(v)) {
      errors.push(`metric "${key}" has no numeric value`);
    }
  }
  return errors;
}

// Compares the working tree's snapshot.json against the version committed at
// `ref` — the PR base branch in CI. A `record` on a feature branch can only
// legitimately move a metric toward its snapshot's `direction`; this catches
// a snapshot.json hand-edited (or generated from a stale measurement) to fake
// an improvement that never happened in code.
async function runBaselineGuard(ref: string | undefined): Promise<void> {
  if (!ref) {
    console.error('baseline-guard requires a git ref, e.g. `ratchet baseline-guard origin/main`');
    process.exit(2);
  }

  const result = await loadBaselineSnapshotAt(ref);
  if (result.kind === 'error') {
    // git itself failed to resolve `ref` — fail loud rather than skip, or a
    // typo'd/garbage ref would silently disable the anti-tamper gate.
    console.error(`baseline-guard: could not resolve ${SNAPSHOT_REPO_PATH} at ${ref}: ${result.message}`);
    process.exit(2);
  }
  if (result.kind === 'absent') {
    console.log(`baseline-guard: no ${SNAPSHOT_REPO_PATH} found at ${ref} — nothing to compare against, skipping.`);
    return;
  }

  const current = await readSnapshot();
  if (!current) {
    console.error('no snapshot.json in the working tree — run `pnpm ratchet:record` first.');
    process.exit(2);
  }

  const shapeErrors = [
    ...snapshotShapeErrors({ metrics: result.metrics }).map((e) => `${ref}: ${e}`),
    ...snapshotShapeErrors(current).map((e) => `working tree: ${e}`),
  ];
  if (shapeErrors.length) {
    console.error('baseline-guard: malformed snapshot.json shape:');
    for (const e of shapeErrors) console.error(`  • ${e}`);
    process.exit(2);
  }

  const { violations, removed } = baselineGuardViolations(result.metrics, current.metrics ?? {});

  if (removed.length) {
    const message = `baseline-guard: metric(s) present at ${ref} are missing from the current snapshot.json: ${removed.join(', ')} — confirm the adapter was deleted deliberately.`;
    console.log(process.env.GITHUB_ACTIONS ? `::warning::${message}` : `⚠️  ${message}`);
  }

  if (violations.length) {
    console.error(`baseline-guard: snapshot.json regressed against ${ref}:`);
    for (const v of violations) console.error(`  • ${v}`);
    process.exit(1);
  }

  console.log(`baseline-guard: snapshot.json is consistent with ${ref}.`);
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'check';

  if (cmd === 'baseline-guard') {
    await runBaselineGuard(process.argv[3]);
    return;
  }

  if (!['record', 'check', 'diff'].includes(cmd)) {
    console.error(`unknown command "${cmd}". use: record | check | diff | baseline-guard <ref>`);
    process.exit(2);
  }

  const adapters = await loadAdapters();
  if (adapters.length === 0) {
    console.error('no adapters found in tools/ratchet/adapters');
    process.exit(2);
  }

  const baseline = await readSnapshot();
  if (cmd !== 'record' && !baseline) {
    console.error('no snapshot.json yet — run `pnpm ratchet:record` first.');
    process.exit(2);
  }

  if (cmd !== 'record' && baseline) {
    const shapeErrors = snapshotShapeErrors(baseline);
    if (shapeErrors.length) {
      console.error('snapshot.json has an invalid shape:');
      for (const e of shapeErrors) console.error(`  • ${e}`);
      process.exit(2);
    }

    const orphans = orphanedMetrics(adapters.map((a) => a.id), baseline.metrics ?? {});
    if (orphans.length) {
      console.error(
        `orphaned metric(删 adapter 必须同时从 snapshot 移除该维度): ${orphans.join(', ')}`,
      );
      process.exit(2);
    }
  }

  const current = await measureAll(adapters);

  if (cmd === 'record') {
    printTable(adapters, baseline, current);
    await writeFile(SNAPSHOT, JSON.stringify({ metrics: current }, null, 2) + '\n');
    console.log(`📸 snapshot written to ${SNAPSHOT.replace(process.cwd() + '/', '')}`);
    return;
  }

  // check / diff: detect regressions per each dimension's gate mode.
  if (!baseline) return; // unreachable: guarded above, narrows the type for TS
  const regressions = adapters
    .map((a) => {
      const base = baseline.metrics?.[a.id];
      if (!base) return null; // brand-new metric can't regress
      const cur = current[a.id];
      if (!cur) return null;
      const detail = regressionsOf(a, base, cur);
      return detail.length ? { a, detail } : null;
    })
    .filter((r): r is { a: Adapter; detail: string[] } => r !== null);
  const regressedIds = new Set(regressions.map((r) => r.a.id));

  printTable(adapters, baseline, current, regressedIds);

  if (regressions.length) {
    console.log('❌ regressions:');
    for (const { a, detail } of regressions) {
      console.log(`  • ${a.id} (${a.title})`);
      for (const line of detail) console.log(`      ${line}`);
    }
  }

  const improved = adapters.filter((a) => {
    const base = baseline.metrics?.[a.id];
    const cur = current[a.id];
    return base && cur && better(a.direction, base.value, cur.value);
  });
  if (improved.length) {
    console.log(`🎉 improved: ${improved.map((a) => a.id).join(', ')}`);
    console.log('   run `pnpm ratchet:record` to lock in the gains.');
  }

  if (cmd === 'check') {
    const notice = improvementNotice(improved.map((a) => a.id), !!process.env.GITHUB_ACTIONS);
    if (notice) console.log(notice);
  }

  if (cmd === 'check' && regressions.length) {
    process.exit(1);
  }
}

// Only run the CLI when invoked directly, so tests can import the helpers above.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((e: unknown) => {
    console.error(e);
    process.exit(2);
  });
}
