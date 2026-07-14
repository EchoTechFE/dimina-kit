// Type-coverage gate — wraps the `type-coverage` CLI (mature, local, OSS),
// which reports the share of identifiers with a non-`any` type. There is no root
// tsconfig, so the adapter runs type-coverage once per package that ships a
// tsconfig.json and aggregates the raw counts into one overall percentage.
//
// Higher is better: the gate fails if overall coverage drops below the snapshot,
// which catches new `any`s leaking into shipped code.

import { execFile } from 'node:child_process';
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
    const tsconfig = `packages/${name}/tsconfig.json`;
    const { stdout } = await pexec(BIN, ['-p', tsconfig, '--json-output'], {
      cwd: ROOT,
      maxBuffer: 64 * 1024 * 1024,
    });
    const json = JSON.parse(stdout) as TypeCoverageJson;
    correct += json.correctCount;
    total += json.totalCount;
    breakdown[name] = json.percent;
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
