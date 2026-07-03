// Circular-import ratchet — flags production files under packages/*/src whose
// imports (static, dynamic, or through a tsconfig `paths` alias) form a
// cycle. A cycle means initialization order depends on which file happens to
// load first, which is a recurring source of "works until you touch an
// unrelated import" bugs.
//
// Self-implemented (no madge/dpdm dependency): import/export-from specifiers
// and dynamic `import()` calls are extracted with a regex (after comments and
// non-specifier string literals are masked out, so import-shaped text in a
// comment or a string constant can't fabricate an edge), each specifier is
// resolved to a concrete file on disk the same way Node/TS would ('./x.ts'
// explicit, './x' implied .ts/.tsx/index.ts, or a tsconfig `paths` alias
// rewritten to its target before the same extension resolution), and Tarjan's
// algorithm finds strongly connected components of size > 1 (a cycle) over
// that file graph. This mirrors what dpdm/madge do internally, without adding
// a dependency for a single regex-and-graph pass — the resolution rules only
// need to cover the specifier styles this codebase actually uses (see
// circular-deps.test.ts and review-hardening.test.ts).
//
// Scope matches the other adapters: production source only, excluding
// *.test.ts(x)/*.spec.*/*.d.ts and dist/node_modules/build/generated
// directories. Only relative and alias-resolved import edges are followed, so
// the graph — and therefore any cycle this adapter can find — never crosses a
// package boundary (packages import each other via their published entry
// points, not relative paths or another package's aliases).
//
// The metric is the number of cycles found. The breakdown names each cycle by
// its member files (root-relative, joined) and records the cycle's length.

import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve as resolvePath, sep } from 'node:path';
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

// A package's tsconfig `paths` aliases, already anchored to an absolute
// baseUrl so a matched alias can be joined straight into a physical path.
type AliasConfig = { baseUrlAbs: string; paths: Record<string, string[]> };

// tsconfig.json commonly carries comments and trailing commas that
// JSON.parse rejects. This is a conservative strip, not a real JSONC parser:
// good enough for the shapes tsconfig actually uses, and a parse failure
// after stripping just falls back to "no aliases" rather than throwing.
function stripJsonComments(text: string): string {
  const withoutBlockComments = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const withoutLineComments = withoutBlockComments.replace(/(^|\s)\/\/.*$/gm, '');
  return withoutLineComments.replace(/,(\s*[}\]])/g, '$1');
}

async function loadAliasConfig(pkgDir: string): Promise<AliasConfig | null> {
  const tsconfigPath = join(pkgDir, 'tsconfig.json');
  if (!existsSync(tsconfigPath)) return null;
  let raw: string;
  try {
    raw = await readFile(tsconfigPath, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(raw));
  } catch {
    return null;
  }
  const co = (parsed as { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } }).compilerOptions;
  if (!co?.paths) return null;
  return { baseUrlAbs: resolvePath(pkgDir, co.baseUrl ?? '.'), paths: co.paths };
}

// One AliasConfig per package directory that has a tsconfig.json with
// `paths` — read once per `measure()` call rather than per file.
async function loadAliasConfigs(packagesDir: string): Promise<Map<string, AliasConfig | null>> {
  const configs = new Map<string, AliasConfig | null>();
  let pkgEntries;
  try {
    pkgEntries = await readdir(packagesDir, { withFileTypes: true });
  } catch {
    return configs;
  }
  for (const pkg of pkgEntries) {
    if (!pkg.isDirectory()) continue;
    const pkgDir = join(packagesDir, pkg.name);
    configs.set(pkgDir, await loadAliasConfig(pkgDir));
  }
  return configs;
}

function aliasForFile(
  file: string,
  packagesDir: string,
  aliasConfigs: Map<string, AliasConfig | null>,
): AliasConfig | null {
  const pkgName = relative(packagesDir, file).split(sep)[0];
  if (!pkgName) return null;
  return aliasConfigs.get(join(packagesDir, pkgName)) ?? null;
}

// Matches the specifier string of `import … from '…'`, `export … from '…'`,
// and bare side-effect imports (`import '…';`).
const SPEC_RE = /(?:^|[\s;])(?:import|export)\s+(?:[^'";]*?\bfrom\s*)?['"]([^'"]+)['"]/gm;

// Matches the target of a dynamic `import('…')` call — a cycle hidden behind
// a dynamic import still makes initialization order load-order-dependent, so
// it counts as a real edge just like a static one.
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

const QUOTES = new Set(["'", '"', '`']);

// Single pass that drops comment text and masks the contents of string
// literals that are not an import/export/dynamic-import specifier, so text
// that merely looks like an import — inside a comment, or inside an unrelated
// string constant such as a code example — can't be mistaken for a real edge
// by SPEC_RE/DYNAMIC_IMPORT_RE below. A specifier string is one immediately
// preceded (ignoring whitespace) by `from`, `import(`, or a bare `import`
// (side-effect import) — the only positions those regexes actually read a
// path out of.
function sanitizeForEdges(source: string): string {
  let out = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const two = source.slice(i, i + 2);
    if (two === '//') {
      while (i < n && source[i] !== '\n') i += 1;
      continue;
    }
    if (two === '/*') {
      i += 2;
      while (i < n && source.slice(i, i + 2) !== '*/') i += 1;
      i += 2;
      continue;
    }
    const ch = source[i];
    if (ch !== undefined && QUOTES.has(ch)) {
      const quote = ch;
      let j = i + 1;
      while (j < n && source[j] !== quote) {
        j += source[j] === '\\' ? 2 : 1;
      }
      const literal = source.slice(i, Math.min(j + 1, n));
      const isSpecifier =
        /\bfrom\s*$/.test(out) || /\bimport\s*\(\s*$/.test(out) || /\bimport\s+$/.test(out);
      out += isSpecifier ? literal : quote + '_'.repeat(Math.max(0, literal.length - 2)) + quote;
      i = j + 1;
      continue;
    }
    out += ch ?? '';
    i += 1;
  }
  return out;
}

function extractSpecifiers(content: string): string[] {
  const specs: string[] = [];
  for (const match of content.matchAll(SPEC_RE)) {
    if (match[1]) specs.push(match[1]);
  }
  for (const match of content.matchAll(DYNAMIC_IMPORT_RE)) {
    if (match[1]) specs.push(match[1]);
  }
  return specs;
}

function candidatesFor(base: string): string[] {
  if (/\.(ts|tsx)$/.test(base)) return [base];
  return [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')];
}

// Rewrites a non-relative specifier into physical candidate base paths
// through a tsconfig `paths` alias (e.g. `@/foo` -> `src/renderer/foo`).
// Only single-wildcard patterns (`@/*`) are supported — that covers every
// alias style this codebase uses. Multiple targets for one pattern are
// returned in order so the caller can take the first that actually resolves
// to a file.
function resolveAliasBases(spec: string, alias: AliasConfig | null): string[] {
  if (!alias) return [];
  for (const [pattern, targets] of Object.entries(alias.paths)) {
    const starIdx = pattern.indexOf('*');
    if (starIdx === -1) {
      if (pattern !== spec) continue;
      return targets.map((t) => join(alias.baseUrlAbs, t));
    }
    const prefix = pattern.slice(0, starIdx);
    const suffix = pattern.slice(starIdx + 1);
    if (!spec.startsWith(prefix) || !spec.endsWith(suffix)) continue;
    if (spec.length < prefix.length + suffix.length) continue;
    const matched = spec.slice(prefix.length, spec.length - suffix.length);
    return targets.map((t) => {
      const ti = t.indexOf('*');
      return join(alias.baseUrlAbs, ti === -1 ? t : t.slice(0, ti) + matched + t.slice(ti + 1));
    });
  }
  return [];
}

function resolveSpecifier(
  fromFile: string,
  spec: string,
  fileSet: Set<string>,
  alias: AliasConfig | null,
): string | null {
  if (spec.startsWith('.')) {
    const base = resolvePath(dirname(fromFile), spec);
    for (const candidate of candidatesFor(base)) {
      if (fileSet.has(candidate)) return candidate;
    }
    return null;
  }
  for (const base of resolveAliasBases(spec, alias)) {
    for (const candidate of candidatesFor(base)) {
      if (fileSet.has(candidate)) return candidate;
    }
  }
  return null;
}

async function buildGraph(
  files: string[],
  packagesDir: string,
  aliasConfigs: Map<string, AliasConfig | null>,
): Promise<Map<string, Set<string>>> {
  const fileSet = new Set(files);
  const graph = new Map<string, Set<string>>();
  for (const file of files) graph.set(file, new Set());
  for (const file of files) {
    const raw = await readFile(file, 'utf8');
    const content = sanitizeForEdges(raw);
    const edges = graph.get(file);
    if (!edges) continue;
    const alias = aliasForFile(file, packagesDir, aliasConfigs);
    for (const spec of extractSpecifiers(content)) {
      const resolved = resolveSpecifier(file, spec, fileSet, alias);
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
  const aliasConfigs = await loadAliasConfigs(packagesDir);
  const graph = await buildGraph(files, packagesDir, aliasConfigs);
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
