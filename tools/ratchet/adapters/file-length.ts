// File-length ratchet — counts source files longer than THRESHOLD lines. Long
// files are a maintainability smell and, just as importantly here, a direct cost
// to AI-assisted development: a 2000-line file burns the context window before any
// work begins. Keeping files bounded keeps them reviewable by humans and loadable
// by tools.
//
// Pure filesystem scan, no tool dependency — survives any linter/build change.
// Test files are intentionally INCLUDED: a giant test file consumes context just
// as a giant source file does. Declaration files and built output are excluded.

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Adapter, MeasureResult } from '../lib/types.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PACKAGES = join(ROOT, 'packages');
const THRESHOLD = 500;

function isSource(name: string): boolean {
  if (!/\.tsx?$/.test(name)) return false;
  if (/\.d\.ts$/.test(name)) return false;
  return true;
}

async function* walk(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (isSource(e.name)) yield p;
  }
}

function lineCount(text: string): number {
  if (text.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  // A trailing newline shouldn't inflate the count by one empty line.
  return text.charCodeAt(text.length - 1) === 10 ? n - 1 : n;
}

async function measure(): Promise<MeasureResult> {
  const breakdown: Record<string, number> = {};
  let count = 0;
  for (const pkg of await readdir(PACKAGES, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    for await (const file of walk(join(PACKAGES, pkg.name, 'src'))) {
      const lines = lineCount(await readFile(file, 'utf8'));
      if (lines > THRESHOLD) {
        breakdown[relative(ROOT, file)] = lines;
        count += 1;
      }
    }
  }
  return { value: count, unit: `files > ${THRESHOLD} lines`, breakdown };
}

const adapter: Adapter = {
  id: 'file-length',
  title: `Files over ${THRESHOLD} lines`,
  direction: 'lower-is-better',
  // Scalar only: the metric is "how many files cross the limit". Incremental
  // growth of an already-long file shouldn't fail CI — only a new file crossing
  // the line (which moves the total) should.
  gate: 'total',
  measure,
};

export default adapter;
