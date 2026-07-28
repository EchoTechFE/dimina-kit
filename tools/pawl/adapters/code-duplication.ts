// Code-duplication gate — delegates clone detection to jscpd (token-based
// copy-paste detection, local Rust binary, no online service). Token-level
// matching also catches "similar" code where only identifiers/literals changed
// slightly, not just byte-identical blocks.
//
// The metric is the total number of duplicated lines across production source
// (statistics.total.duplicatedLines from jscpd's JSON report). The breakdown
// names each clone pair as `fileA:start↔fileB:start` with root-relative paths,
// so the snapshot stays comparable across machines and worktrees.
//
// Gate is `total`: refactors legitimately move clone boundaries around (an
// extraction can shift where a residual clone starts), so per-file accounting
// would flag innocent moves; only a net increase in duplicated lines fails.

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { ROOT } from '../lib/eslint.ts';
import type { Adapter, MeasureOptions, MeasureResult } from '../lib/types.ts';

// jscpd's default minimum clone size, pinned so an upstream default change
// cannot silently move the baseline.
export const MIN_TOKENS = 50;

// Production source only — mirrors the lint-backed adapters' scope. Test files
// legitimately re-declare fixtures; declaration files repeat type shapes;
// vendored deps / build products / codegen output are not hand-written code.
const IGNORE = [
  '**/*.test.ts',
  '**/*.test.tsx',
  '**/*.spec.ts',
  '**/*.spec.tsx',
  '**/*.d.ts',
  '**/dist/**',
  '**/node_modules/**',
  '**/build/**',
  '**/generated/**',
].join(',');

const JSCPD_BIN = join(
  dirname(createRequire(import.meta.url).resolve('jscpd/package.json')),
  'run-jscpd.js',
);

type JscpdDuplicate = {
  firstFile: { name: string; start: number };
  secondFile: { name: string; start: number };
  lines: number;
};
type JscpdReport = {
  duplicates?: JscpdDuplicate[];
  statistics?: { total?: { duplicatedLines?: number } };
};

async function srcDirs(root: string): Promise<string[]> {
  const packagesDir = join(root, 'packages');
  if (!existsSync(packagesDir)) return [];
  const entries = await readdir(packagesDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => join(packagesDir, e.name, 'src'))
    .filter((p) => existsSync(p));
}

function runJscpd(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [JSCPD_BIN, ...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`jscpd exited with ${code}: ${stderr}`));
    });
  });
}

async function measure(opts: MeasureOptions = {}): Promise<MeasureResult> {
  // jscpd reports realpath'd absolute names (macOS: /var/… → /private/var/…),
  // so the root must be realpath'd too before relativizing.
  const root = await realpath(opts.root ?? ROOT);
  const dirs = await srcDirs(root);
  if (dirs.length === 0) return { value: 0, unit: 'duplicated lines', breakdown: {} };

  const out = await mkdtemp(join(tmpdir(), 'gate-jscpd-'));
  try {
    await runJscpd([
      ...dirs,
      '--pattern', '**/*.{ts,tsx}',
      '--ignore', IGNORE,
      '--min-tokens', String(MIN_TOKENS),
      '--absolute',
      '--reporters', 'json,silent',
      '--output', out,
    ]);
    const raw = await readFile(join(out, 'jscpd-report.json'), 'utf8');
    const report = JSON.parse(raw) as JscpdReport;
    const rel = (name: string) => (name.startsWith(root + sep) ? name.slice(root.length + 1) : name);
    const breakdown: Record<string, number> = {};
    for (const d of report.duplicates ?? []) {
      const key = `${rel(d.firstFile.name)}:${d.firstFile.start}↔${rel(d.secondFile.name)}:${d.secondFile.start}`;
      breakdown[key] = (breakdown[key] ?? 0) + d.lines;
    }
    const sorted = Object.fromEntries(
      Object.keys(breakdown).sort().map((k) => [k, breakdown[k]]),
    );
    return {
      value: report.statistics?.total?.duplicatedLines ?? 0,
      unit: 'duplicated lines',
      breakdown: sorted,
    };
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}

const adapter: Adapter = {
  id: 'code-duplication',
  title: `Duplicated code lines (jscpd, ≥${MIN_TOKENS} tokens)`,
  direction: 'lower-is-better',
  gate: 'total',
  measure,
};

export default adapter;
