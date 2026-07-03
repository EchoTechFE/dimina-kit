# ratchet — anti-regression baseline

A tool-agnostic quality ratchet. Each **adapter** measures one dimension and
returns a number (plus an optional per-file breakdown). The engine snapshots
those numbers to [`snapshot.json`](./snapshot.json); the gate re-measures and
fails when any dimension regresses against the snapshot.

The underlying analyzer is an implementation detail of each adapter. Swapping a
tool (e.g. eslint → oxlint) means rewriting one adapter while the recorded
baseline and the CI gate stay put. Everything runs locally — no online services.

Written in TypeScript and run directly by Node's native type stripping (Node
24; no `tsx`/`ts-node`). That constrains the syntax to what's erasable —
no `enum`, `namespace`, or constructor parameter properties — and every
local import must carry an explicit `.ts` extension. `tools/ratchet/tsconfig.json`
typechecks the directory in isolation (`pnpm exec tsc -p tools/ratchet`); it
is not part of any package's `check-types` task.

## Commands

```bash
pnpm ratchet:record          # measure every dimension and (over)write the baseline
pnpm ratchet:check           # measure + compare; exit 1 on any regression — the CI gate
pnpm ratchet:diff            # measure + compare, print the table, never fail
node tools/ratchet/ratchet.ts baseline-guard <git-ref>
                              # compare the working tree's snapshot.json against
                              # the version committed at <ref> — the PR-vs-base-branch gate
```

Record establishes the baseline and locks in improvements after cleanup. After a
verified cleanup, `diff` shows the gain (e.g. `type-escapes 11 → 10 🎉 better`)
and `record` writes it back so the win can't be undone.

## Dimensions

| id | tool | metric | direction | gate |
|----|------|--------|-----------|------|
| `cognitive-complexity` | [eslint-plugin-sonarjs] | functions over cognitive complexity 15 | lower | per-file-count |
| `type-escapes` | [typescript-eslint] | explicit `any` + `@ts-*` suppressions | lower | per-file-count |
| `type-coverage` | [type-coverage] | overall share of non-`any` identifiers | higher | per-key-value |
| `file-length` | filesystem | files over 500 lines | lower | total |
| `code-duplication` | [jscpd] | duplicated lines across clone pairs (≥50 tokens) | lower | total |
| `circular-deps` | self-implemented | import cycles among production files | lower | total |

Scope is production source (`packages/*/src`, excluding `*.test`/`*.spec`/`*.d.ts`).
Test files legitimately bend these rules around fixtures — except for `file-length`,
which counts test files too: a giant test burns the AI context window just like a
giant source file does.

The lint-backed adapters run with `noInlineConfig`, so an `// eslint-disable`
comment cannot hide a violation from the ratchet — the baseline measures the real
escape surface, and the gate can't be bypassed by suppressing.

### Gate strictness

Each dimension declares how `check` compares against the snapshot, so a localized
regression can't hide behind an unchanged scalar total (file A improves while file
B worsens, total flat):

- **`total`** — scalar only. For `file-length`, where the metric is "how many
  files cross the limit"; growing an already-long file shouldn't fail CI, only a
  new file crossing it (which moves the total) should. Also for `code-duplication`
  and `circular-deps`: a refactor legitimately moves clone boundaries or import
  edges around, so per-file accounting would flag innocent moves — only a net
  increase in the total fails.
- **`per-file-count`** — no file may gain offenders. Counting offenders *per file*
  (not per line) keeps it robust: moving code around a file doesn't trip it, but
  adding an `any` / a complex function to any file does.
- **`per-key-value`** — no individual key may worsen. For `type-coverage`, every
  package's coverage must hold or rise, not just the overall percentage.

A dimension's `gate` defaults to `total` when unset.

## Guards beyond the per-dimension gate

Three checks protect the ratchet itself, not just the dimensions it measures:

- **Orphaned-metric check.** `check`/`diff` refuse to run (exit 2) if
  `snapshot.json` still carries a dimension whose adapter file was deleted —
  deleting an adapter must also drop its entry from the snapshot (re-`record`),
  so a regression on that dimension can't hide behind a vanished measurement.
- **`baseline-guard <ref>`.** Compares the working tree's `snapshot.json`
  against the version committed at `<ref>` (in CI: the PR's base branch, via a
  `git fetch --depth=1` + `FETCH_HEAD`). This is what actually stops a
  hand-edited `snapshot.json` from faking a pass — `check` alone only verifies
  internal consistency between the file on disk and a fresh measurement of the
  current code, not that the file's history is honest. A dimension missing at
  `<ref>` (a new adapter) is ignored; a dimension present at `<ref>` but
  missing from the current snapshot prints a warning (`::warning::` under
  `GITHUB_ACTIONS`) without failing, since deleting an adapter is legitimate as
  long as the orphaned-metric check above is also satisfied.
- **Improvement notice.** When `check` runs on CI (`GITHUB_ACTIONS` set) and at
  least one dimension improved since the snapshot, it prints an
  `::notice::` naming the improved dimensions and pointing at
  `pnpm ratchet:record` — so an unrecorded win surfaces on the PR itself, not
  only in a `diff` run a developer might not think to check.

## Notes & known limits

- **cognitive-complexity** uses the canonical SonarJS engine via ESLint's Node
  API; the algorithm is not reimplemented. oxlint cannot replace it — SonarJS-class
  rules are type-aware ([oxc#4863]).
- **code-duplication** runs the jscpd CLI (a local Rust binary; jscpd ≥5 ships no
  JS API) with `--min-tokens 50` pinned, token-level matching, so renamed-identifier
  copies still count as clones. Cognitive complexity measures how tangled one
  function is; this dimension catches the opposite failure mode — logic that stays
  simple per copy but is pasted across files.
- **circular-deps** is self-implemented (a regex over import/export-from
  specifiers and dynamic `import()` calls, resolved the way Node/TS would —
  including a package's own tsconfig `paths` aliases (e.g. `@/*`) — fed into
  Tarjan's SCC algorithm) rather than built on madge/dpdm — a single
  regex-and-graph pass didn't justify a new dependency. Import-shaped text
  inside comments or string literals is masked out before matching, so it
  can't fabricate an edge. Scope is deliberately narrow: only relative and
  same-package-alias imports are followed, so a detected cycle is always
  contained within one package's `src` — a cycle formed through two packages'
  published entry points (`@scope/pkg-a` importing `@scope/pkg-b` importing
  back) is out of this dimension's reach and would need a package-graph-level
  tool instead.
- **No dead-code dimension.** A knip-based unused-exports ratchet was tried and
  removed. The devtools packages expose extension APIs for downstream secondary
  development, so *any* export may have an out-of-repo consumer that static
  analysis cannot see — "unused" never means "deletable", and gating it would
  red-flag every legitimate new public API. knip's file- and dependency-level
  signals are likewise dominated by false positives here (Vite/electron entry
  points, the devkit server's runtime deps) without an exhaustive entry map.
  Reintroducing it would require declaring every public entry point in a knip
  config first, and even then export-level detection stays unusable.

## Adding a dimension

Drop a `*.ts` in [`adapters/`](./adapters) with a default export shaped like
`Adapter` (see [`lib/types.ts`](./lib/types.ts)):

```ts
import type { Adapter } from '../lib/types.ts';

const adapter: Adapter = {
  id: 'my-metric',
  title: 'Human readable title',
  direction: 'lower-is-better', // or 'higher-is-better'
  async measure() {
    return { value: 42, unit: 'things', breakdown: { 'file.ts': 42 } };
  },
};

export default adapter;
```

Then `pnpm ratchet:record` to add it to the baseline.

[eslint-plugin-sonarjs]: https://github.com/SonarSource/eslint-plugin-sonarjs
[typescript-eslint]: https://typescript-eslint.io/
[type-coverage]: https://github.com/plantain-00/type-coverage
[jscpd]: https://github.com/kucherenko/jscpd
[oxc#4863]: https://github.com/oxc-project/oxc/discussions/4863
