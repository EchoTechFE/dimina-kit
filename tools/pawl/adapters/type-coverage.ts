// Type-coverage gate — wraps the `type-coverage` CLI (mature, local, OSS),
// which reports the share of identifiers with a non-`any` type. There is no root
// tsconfig, so the adapter runs type-coverage once per package that ships a
// tsconfig.json and aggregates the raw counts into one overall percentage.
//
// Higher is better: the gate fails if overall coverage drops below the snapshot,
// which catches new `any`s leaking into shipped code.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Adapter, MeasureResult } from '../lib/types.ts';

const pexec = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PACKAGES = join(ROOT, 'packages');
const BIN = join(ROOT, 'node_modules', '.bin', 'type-coverage');

type TypeCoverageJson = {
  correctCount: number;
  totalCount: number;
  percent: number;
};

// A package's tsconfig.json is not always all of its source. Where a package
// compiles part of itself through a separate project — different module or JSX
// settings — that project is listed here, or the source it owns leaves the gate
// without anything failing: identifiers simply stop being counted.
const EXTRA_PROJECTS: Record<string, readonly string[]> = {
  // Browser code for a bundler, so the package's Node16 tsconfig.json excludes
  // it. This is the project that defines what the subpath export ships.
  'dimina-electron-runtime': ['tsconfig.simulator-ui.build.json'],
};

async function packagesWithTsconfig(): Promise<string[]> {
  const out: string[] = [];
  for (const pkg of await readdir(PACKAGES, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    try {
      const files = await readdir(join(PACKAGES, pkg.name));
      if (files.includes('tsconfig.json')) out.push(pkg.name);
    } catch {
      // skip
    }
  }
  return out;
}

async function measure(): Promise<MeasureResult> {
  const breakdown: Record<string, number> = {};
  let correct = 0;
  let total = 0;
  for (const name of await packagesWithTsconfig()) {
    const measured: TypeCoverageJson[] = [];
    for (const project of ['tsconfig.json', ...(EXTRA_PROJECTS[name] ?? [])]) {
      const tsconfig = `packages/${name}/${project}`;
      // A listed project that no longer exists would otherwise drop its source
      // from the measurement quietly, which is the exact failure this guards.
      if (!existsSync(join(ROOT, tsconfig))) {
        throw new Error(`type-coverage: ${tsconfig} is listed but missing`);
      }
      const { stdout } = await pexec(BIN, ['-p', tsconfig, '--json-output'], {
        cwd: ROOT,
        maxBuffer: 64 * 1024 * 1024,
      });
      measured.push(JSON.parse(stdout) as TypeCoverageJson);
    }
    const packageCorrect = measured.reduce((sum, m) => sum + m.correctCount, 0);
    const packageTotal = measured.reduce((sum, m) => sum + m.totalCount, 0);
    correct += packageCorrect;
    total += packageTotal;
    // The single-project case keeps reporting the CLI's own percentage. Rounding
    // the ratio here instead would shift some packages by 0.01 for no change in
    // their code — a per-key gate would read that as an improvement.
    const single = measured.length === 1 ? measured[0] : undefined;
    breakdown[name] = single
      ? single.percent
      : packageTotal === 0
        ? 100
        : Math.round((packageCorrect / packageTotal) * 10000) / 100;
  }
  const percent = total === 0 ? 100 : Math.round((correct / total) * 10000) / 100;
  return { value: percent, unit: '%', breakdown };
}

const adapter: Adapter = {
  id: 'type-coverage',
  title: 'Overall type coverage (non-any identifiers)',
  direction: 'higher-is-better',
  // No individual package's coverage may drop, even if the overall % holds.
  gate: 'per-key-value',
  measure,
};

export default adapter;
