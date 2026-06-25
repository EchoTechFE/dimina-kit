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
//   record  measure every dimension and (over)write the snapshot — use this to
//           establish the baseline and to lock in improvements after cleanup.
//   check   measure and compare against the snapshot; exit 1 if anything got
//           worse. This is the CI gate.
//   diff    measure and compare, print the table, always exit 0. This answers
//           "how far did this cleanup move the numbers" without gating.

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ADAPTERS_DIR = join(HERE, 'adapters');
const SNAPSHOT = join(HERE, 'snapshot.json');

async function loadAdapters() {
  const files = (await readdir(ADAPTERS_DIR))
    .filter((f) => f.endsWith('.mjs'))
    .sort();
  const adapters = [];
  for (const f of files) {
    const mod = await import(pathToFileURL(join(ADAPTERS_DIR, f)).href);
    adapters.push(mod.default);
  }
  return adapters;
}

async function measureAll(adapters) {
  const metrics = {};
  for (const a of adapters) {
    process.stderr.write(`  measuring ${a.id}…\n`);
    const r = await a.measure();
    metrics[a.id] = {
      direction: a.direction,
      value: r.value,
      unit: r.unit ?? 'count',
      breakdown: r.breakdown ?? null,
    };
  }
  return metrics;
}

function worse(direction, base, cur) {
  return direction === 'higher-is-better' ? cur < base : cur > base;
}
function better(direction, base, cur) {
  return direction === 'higher-is-better' ? cur > base : cur < base;
}

// Offender count per file from a `path:line …`-keyed breakdown. Counting keys
// (not summing their values) makes the gate robust to code moving lines around:
// the same file keeps the same offender count even as line numbers shift.
function offenderCountsByFile(breakdown) {
  const out = {};
  for (const k of Object.keys(breakdown ?? {})) {
    const f = k.split(':')[0];
    out[f] = (out[f] ?? 0) + 1;
  }
  return out;
}

// Regression detail for one dimension, honoring its `gate` mode. Returns
// human-readable lines (empty = no regression). The scalar total is always
// checked; the per-file / per-key check on top of it stops a localized
// regression from hiding behind a net-zero total (file A improves, file B
// worsens, total unchanged).
//   total          — scalar only (e.g. file-length: count of files over a limit)
//   per-file-count — offender count per file may not rise (type-escapes, cognitive)
//   per-key-value  — each key's value may not worsen (type-coverage: per-package %)
export function regressionsOf(a, base, cur) {
  const out = [];
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
      if (k in c && worse(a.direction, b[k], c[k])) out.push(`${k}  ${b[k]} → ${c[k]}`);
    }
  }
  return out;
}

function fmtDelta(direction, base, cur) {
  if (base == null) return 'new';
  const d = Math.round((cur - base) * 100) / 100;
  if (d === 0) return '±0';
  return d > 0 ? `+${d}` : `${d}`;
}

function statusOf(direction, base, cur) {
  if (base == null) return '🆕 new';
  if (worse(direction, base, cur)) return '❌ worse';
  if (better(direction, base, cur)) return '🎉 better';
  return '✅ same';
}

function printTable(adapters, baseline, current, regressedIds = new Set()) {
  const rows = adapters.map((a) => {
    const base = baseline?.metrics?.[a.id]?.value ?? null;
    const cur = current[a.id].value;
    return {
      id: a.id,
      title: a.title,
      unit: current[a.id].unit,
      base,
      cur,
      delta: fmtDelta(a.direction, base, cur),
      // A per-file/per-key regression can leave the scalar unchanged, so let the
      // gate's verdict override the scalar-only status.
      status: regressedIds.has(a.id) ? '❌ worse' : statusOf(a.direction, base, cur),
    };
  });
  const w = (s) => String(s ?? '—');
  const pad = (s, n) => w(s).padEnd(n);
  const padL = (s, n) => w(s).padStart(n);
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

async function readSnapshot() {
  if (!existsSync(SNAPSHOT)) return null;
  return JSON.parse(await readFile(SNAPSHOT, 'utf8'));
}

async function main() {
  const cmd = process.argv[2] ?? 'check';
  if (!['record', 'check', 'diff'].includes(cmd)) {
    console.error(`unknown command "${cmd}". use: record | check | diff`);
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

  const current = await measureAll(adapters);

  if (cmd === 'record') {
    printTable(adapters, baseline, current);
    await writeFile(SNAPSHOT, JSON.stringify({ metrics: current }, null, 2) + '\n');
    console.log(`📸 snapshot written to ${SNAPSHOT.replace(process.cwd() + '/', '')}`);
    return;
  }

  // check / diff: detect regressions per each dimension's gate mode.
  const regressions = adapters
    .map((a) => {
      const base = baseline.metrics?.[a.id];
      if (!base) return null; // brand-new metric can't regress
      const detail = regressionsOf(a, base, current[a.id]);
      return detail.length ? { a, detail } : null;
    })
    .filter(Boolean);
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
    return base && better(a.direction, base.value, current[a.id].value);
  });
  if (improved.length) {
    console.log(`🎉 improved: ${improved.map((a) => a.id).join(', ')}`);
    console.log('   run `pnpm ratchet:record` to lock in the gains.');
  }

  if (cmd === 'check' && regressions.length) {
    process.exit(1);
  }
}

// Only run the CLI when invoked directly, so tests can import the helpers above.
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((e) => {
    console.error(e);
    process.exit(2);
  });
}
