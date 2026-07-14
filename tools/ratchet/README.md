# ratchet — dimina-kit's anti-regression adapters

The anti-regression gate is [**pawl**](https://github.com/tiangong-dev/pawl), a
language-agnostic quality ratchet: it snapshots one number per dimension and
fails CI when any dimension regresses. This directory holds only the
dimina-kit-specific **adapters** — the `measure()` functions that compute each
number. The gate engine (record / check / diff / baseline-guard, the gate
modes, tolerance, and the guards below) lives in pawl, configured by
[`../../pawl.yaml`](../../pawl.yaml); the baseline is
[`../../pawl.snapshot.json`](../../pawl.snapshot.json).

Each dimension in `pawl.yaml` is an [exec adapter] whose `command` is
`node tools/ratchet/pawl-adapter.ts <id>`. [`pawl-adapter.ts`](./pawl-adapter.ts)
imports the matching [`adapters/<id>.ts`](./adapters) unchanged, runs its
`measure()`, and prints the `{ value, unit, breakdown }` JSON pawl consumes.
Because the adapter code is the single source of the number, `pnpm ratchet:check`
and any future direct engine call can never disagree on a value.

The underlying analyzer is an implementation detail of each adapter. Swapping a
tool (e.g. eslint → oxlint) means rewriting one adapter while the recorded
baseline and the CI gate stay put. Everything runs locally — no online services.

The adapters and `pawl-adapter.ts` are TypeScript run directly by Node's native
type stripping (no `tsx`/`ts-node`). That constrains the syntax to what's
erasable — no `enum`, `namespace`, or constructor parameter properties — and
every local import must carry an explicit `.ts`/`.js` extension.
`tools/ratchet/tsconfig.json` typechecks the directory in isolation
(`pnpm exec tsc -p tools/ratchet`); it is not part of any package's
`check-types` task.

[exec adapter]: https://github.com/tiangong-dev/pawl#custom-adapters

## Commands

```bash
pnpm ratchet:record          # measure every dimension and (over)write the baseline
pnpm ratchet:check           # measure + compare; exit 1 on any regression — the CI gate
pnpm ratchet:diff            # measure + compare, print the table, never fail
pnpm exec pawl baseline-guard <git-ref>
                             # compare the working tree's pawl.snapshot.json against
                             # the version committed at <ref> — the PR-vs-base-branch gate
```

The `ratchet:*` scripts are thin aliases for `pawl {check,record,diff}` (pawl is
pinned as `@pawl-tools/cli` in the root `devDependencies`). Record establishes
the baseline and locks in improvements after cleanup. After a verified cleanup,
`diff` shows the gain (e.g. `type-escapes 11 → 10 🎉 better`) and `record` writes
it back so the win can't be undone.

## Dimensions

| id | tool | metric | direction | gate |
|----|------|--------|-----------|------|
| `cognitive-complexity` | [eslint-plugin-sonarjs] | functions over cognitive complexity 15 | lower | per-file-count |
| `type-escapes` | [typescript-eslint] | explicit `any` + `@ts-*` suppressions | lower | per-file-count |
| `type-coverage` | [type-coverage] | overall share of non-`any` identifiers | higher | per-key-value |
| `file-length` | filesystem | files over 500 lines | lower | total |
| `code-duplication` | [jscpd] | duplicated lines across clone pairs (≥50 tokens) | lower | total |
| `circular-deps` | self-implemented | import cycles among production files | lower | total |
| `test-report` | vitest JSON reports | tests that actually passed | higher | per-key-value |
| `test-coverage` | vitest v8 coverage summaries | lines covered by tests (all src in denominator) | higher | per-key-value |

Scope is production source (`packages/*/src`, excluding `*.test`/`*.spec`/`*.d.ts`).
Test files legitimately bend these rules around fixtures — except for `file-length`,
which counts test files too: a giant test burns the AI context window just like a
giant source file does.

The lint-backed adapters run with `noInlineConfig`, so an `// eslint-disable`
comment cannot hide a violation from the ratchet — the baseline measures the real
escape surface, and the gate can't be bypassed by suppressing.

### Gate strictness

Each dimension's `gate` (declared in `pawl.yaml`) tells pawl how `check` compares
against the snapshot, so a localized regression can't hide behind an unchanged
scalar total (file A improves while file B worsens, total flat):

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

A dimension may also declare a `tolerance` — absolute slack (same unit as the
value) granted in the worse direction, applied to the total, the per-key checks,
and `baseline-guard` alike (the snapshot records it so the guard sees it without
loading adapters). Exact-count dimensions omit it; `test-coverage` declares
`tolerance: 1` (one percentage point) because runtime coverage carries inherent
measurement noise that a strict comparison would surface as false regressions. A
drop inside the slack prints `✅ within tolerance` and does not fail the gate.

## Guards beyond the per-dimension gate

pawl protects the ratchet itself, not just the dimensions it measures:

- **Cannot-measure is exit 2, never a silent zero.** If an adapter crashes,
  times out, or prints non-JSON, pawl aborts with exit 2 rather than reading the
  failure as "measured zero" — a missing measurement can't pass the gate.
- **`baseline-guard <ref>`.** Compares the working tree's `pawl.snapshot.json`
  against the version committed at `<ref>` (in CI: the PR's base branch, via a
  `git fetch --depth=1` + `FETCH_HEAD`). This is what actually stops a
  hand-edited snapshot from faking a pass — `check` alone only verifies internal
  consistency between the file on disk and a fresh measurement of the current
  code, not that the file's history is honest.
- **Improvement notice.** When `check` runs on CI (`GITHUB_ACTIONS` set) and at
  least one dimension improved since the snapshot, pawl prints a `::notice::`
  naming the improved dimensions and pointing at `pnpm ratchet:record` — so an
  unrecorded win surfaces on the PR itself.

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
- **test-report** does not run any tests itself — it reads the vitest JSON
  reports (`test-report*.json`, gitignored) that each package's `test` script
  emits via `--outputFile.json=…`, and counts `numPassedTests`. Reading the run
  report instead of grepping source for `it(` means every way a test can stop
  counting — deleted, `.skip`ped, excluded from the config, or newly failing —
  lowers the number and fails the gate. The `test` script text is the single
  source of truth for which reports must exist: a script that runs vitest
  without declaring an `--outputFile.json` is an error, and a declared report
  missing from disk fails with "run `pnpm test` first" rather than counting as
  zero. In CI the test step runs before `ratchet:check`, so reports are always
  fresh; locally, a stale report is possible if you measure without re-running
  tests. The reports are declared as turbo outputs of the `test` task, so a
  turbo cache hit restores them instead of leaving them missing.
- **test-coverage** rides the same artifact pipeline: each `test` script also
  passes `--coverage.enabled --coverage.reporter=json-summary
  --coverage.reportsDirectory=<dir>`, and the adapter reads
  `<dir>/coverage-summary.json` per suite (the i-th `--outputFile.json` names
  the i-th suite, the i-th `--coverage.reportsDirectory` locates its summary; a
  count mismatch fails loud). The CLI `--coverage.reporter=json-summary`
  overrides the config's reporter list, so plain `pnpm test` writes only the
  summary — the html/text reporters still run under `pnpm test:coverage`. The
  vitest configs pin `coverage.include` to all of `src/**`, so untested files
  count toward the denominator: without that, vitest only reports files loaded
  during the run and a new untested file would not move the number. The gate is
  per-suite lines %; the scalar is aggregated over real line counts, not an
  average of percentages.
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

1. Drop a `*.ts` in [`adapters/`](./adapters) with a default export shaped like
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

2. Add a dimension to [`../../pawl.yaml`](../../pawl.yaml) with
   `command: "node tools/ratchet/pawl-adapter.ts my-metric"` and the matching
   `direction` / `gate` / `tolerance`.
3. `pnpm ratchet:record` to add it to the baseline.

Keep the adapter's `measure()` as the only place the number is computed — that's
what guarantees the value the gate reads is the value your tests exercise.

[eslint-plugin-sonarjs]: https://github.com/SonarSource/eslint-plugin-sonarjs
[typescript-eslint]: https://typescript-eslint.io/
[type-coverage]: https://github.com/plantain-00/type-coverage
[jscpd]: https://github.com/kucherenko/jscpd
[oxc#4863]: https://github.com/oxc-project/oxc/discussions/4863
