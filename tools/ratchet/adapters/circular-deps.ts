// Circular-import ratchet — flags production files under packages/*/src whose
// relative imports form a cycle. A cycle means initialization order depends on
// which file happens to load first, which is a recurring source of "works
// until you touch an unrelated import" bugs.
//
// Self-implemented (no madge/dpdm dependency): a regex extracts the relative
// specifiers of import/export-from statements, each specifier is resolved to
// a concrete file on disk the same way Node/TS would ('./x.ts' explicit,
// './x' implied .ts/.tsx/index.ts), and Tarjan's algorithm finds strongly
// connected components of size > 1 (a cycle) over that file graph. This mirrors
// what dpdm/madge do internally, without adding a dependency for a single
// regex-and-graph pass — the resolution rules only need to cover the two
// specifier styles this codebase actually uses (see circular-deps.test.ts).
//
// Scope matches the other adapters: production source only, excluding
// *.test.ts(x)/*.spec.*/*.d.ts and dist/node_modules/build/generated
// directories. Only relative-import edges are followed, so the graph — and
// therefore any cycle this adapter can find — never crosses a package
// boundary (packages import each other via their published entry points,
// not relative paths).
//
// The metric is the number of cycles found. The breakdown names each cycle by
// its member files (root-relative, joined) and records the cycle's length.

import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MeasureOptions } from '../lib/types.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const IGNORED_DIRS = new Set(['node_modules', 'dist', 'build', 'generated']);

function isProductionSource(name: string): boolean {
  if (!/\.(ts|tsx)$/.test(name)) return false;
  if (/\.d\.ts$/.test(name)) return false;
  if (/\.test\.(ts|tsx)$/.test(name)) return false;
  if (/\.spec\./.test(name)) return false;
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
    if (e.isDirectory()) {
      if (IGNORED_DIRS.has(e.name)) continue;
      yield* walk(join(dir, e.name));
    } else if (isProductionSource(e.name)) {
      yield join(dir, e.name);
    }
  }
}

async function collectSourceFiles(packagesDir: string): Promise<string[]> {
  const files: string[] = [];
  let pkgEntries;
  try {
    pkgEntries = await readdir(packagesDir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const pkg of pkgEntries) {
    if (!pkg.isDirectory()) continue;
    const srcDir = join(packagesDir, pkg.name, 'src');
    if (!existsSync(srcDir)) continue;
    for await (const file of walk(srcDir)) files.push(file);
  }
  return files;
}

// Matches the specifier string of `import … from '…'`, `export … from '…'`,
// and bare side-effect imports (`import '…';`). Non-relative specifiers
// (package names) are filtered out by the caller — this only needs to find
// the quoted string, not classify it.
const SPEC_RE = /(?:^|[\s;])(?:import|export)\s+(?:[^'";]*?\bfrom\s*)?['"]([^'"]+)['"]/gm;

function resolveSpecifier(fromFile: string, spec: string, fileSet: Set<string>): string | null {
  if (!spec.startsWith('.')) return null;
  const base = resolvePath(dirname(fromFile), spec);
  const candidates = /\.(ts|tsx)$/.test(base)
    ? [base]
    : [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')];
  for (const candidate of candidates) {
    if (fileSet.has(candidate)) return candidate;
  }
  return null;
}

async function buildGraph(files: string[]): Promise<Map<string, Set<string>>> {
  const fileSet = new Set(files);
  const graph = new Map<string, Set<string>>();
  for (const file of files) graph.set(file, new Set());
  for (const file of files) {
    const content = await readFile(file, 'utf8');
    const edges = graph.get(file);
    if (!edges) continue;
    for (const match of content.matchAll(SPEC_RE)) {
      const spec = match[1];
      if (!spec) continue;
      const resolved = resolveSpecifier(file, spec, fileSet);
      if (resolved && resolved !== file) edges.add(resolved);
    }
  }
  return graph;
}

// Tarjan's SCC algorithm. A strongly connected component of size > 1 (or a
// single node with a self-edge) is exactly one import cycle.
function findCycles(graph: Map<string, Set<string>>): string[][] {
  let counter = 0;
  const indexOf = new Map<string, number>();
  const lowlinkOf = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];

  function strongConnect(v: string): void {
    indexOf.set(v, counter);
    lowlinkOf.set(v, counter);
    counter += 1;
    stack.push(v);
    onStack.add(v);

    for (const w of graph.get(v) ?? []) {
      const wIndex = indexOf.get(w);
      if (wIndex === undefined) {
        strongConnect(w);
        const vLow = lowlinkOf.get(v) ?? 0;
        const wLow = lowlinkOf.get(w) ?? 0;
        lowlinkOf.set(v, Math.min(vLow, wLow));
      } else if (onStack.has(w)) {
        const vLow = lowlinkOf.get(v) ?? 0;
        lowlinkOf.set(v, Math.min(vLow, wIndex));
      }
    }

    if (lowlinkOf.get(v) === indexOf.get(v)) {
      const component: string[] = [];
      let w: string | undefined;
      do {
        w = stack.pop();
        if (w === undefined) break;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      const selfLoop = component.length === 1 && (graph.get(v)?.has(v) ?? false);
      if (component.length > 1 || selfLoop) cycles.push(component);
    }
  }

  for (const v of graph.keys()) {
    if (!indexOf.has(v)) strongConnect(v);
  }
  return cycles;
}

// Narrower than the shared MeasureResult: this adapter always produces a unit
// string and a (possibly empty) breakdown object, never omits or nulls them.
type CircularDepsResult = { value: number; unit: string; breakdown: Record<string, number> };

async function measure(opts: MeasureOptions = {}): Promise<CircularDepsResult> {
  const root = opts.root ?? ROOT;
  const packagesDir = join(root, 'packages');
  if (!existsSync(packagesDir)) return { value: 0, unit: 'import cycles', breakdown: {} };

  const files = await collectSourceFiles(packagesDir);
  const graph = await buildGraph(files);
  const cycles = findCycles(graph);

  const breakdown: Record<string, number> = {};
  for (const cycle of cycles) {
    const relPaths = cycle.map((f) => relative(root, f)).sort();
    breakdown[relPaths.join(' -> ')] = cycle.length;
  }

  return { value: cycles.length, unit: 'import cycles', breakdown };
}

// Not annotated as `Adapter` here (unlike the other adapters): that would
// widen `measure`'s return type to the shared MeasureResult, where `unit` and
// `breakdown` are optional — losing the stronger guarantee this adapter
// actually provides. The engine loads this module through a dynamic import
// it casts to `Adapter` itself, so the wider contract is still enforced at
// the boundary that needs it.
const circularDeps = {
  id: 'circular-deps',
  title: 'Circular imports within a package (packages/*/src)',
  direction: 'lower-is-better' as const,
  gate: 'total' as const,
  measure,
};

export default circularDeps;
