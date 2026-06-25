# ratchet — anti-regression baseline

A tool-agnostic quality ratchet. Each **adapter** measures one dimension and
returns a number (plus an optional per-file breakdown). The engine snapshots
those numbers to [`snapshot.json`](./snapshot.json); the gate re-measures and
fails when any dimension regresses against the snapshot.

The underlying analyzer is an implementation detail of each adapter. Swapping a
tool (e.g. eslint → oxlint) means rewriting one adapter while the recorded
baseline and the CI gate stay put. Everything runs locally — no online services.

## Commands

```bash
pnpm ratchet:record   # measure every dimension and (over)write the baseline
pnpm ratchet:check    # measure + compare; exit 1 on any regression — the CI gate
pnpm ratchet:diff     # measure + compare, print the table, never fail
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
  new file crossing it (which moves the total).
- **`per-file-count`** — no file may gain offenders. Counting offenders *per file*
  (not per line) keeps it robust: moving code around a file doesn't trip it, but
  adding an `any` / a complex function to any file does.
- **`per-key-value`** — no individual key may worsen. For `type-coverage`, every
  package's coverage must hold or rise, not just the overall percentage.

A dimension's `gate` defaults to `total` when unset.

## Notes & known limits

- **cognitive-complexity** uses the canonical SonarJS engine via ESLint's Node
  API; the algorithm is not reimplemented. oxlint cannot replace it — SonarJS-class
  rules are type-aware ([oxc#4863]).
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

Drop a `*.mjs` in [`adapters/`](./adapters) with a default export:

```js
export default {
  id: 'my-metric',
  title: 'Human readable title',
  direction: 'lower-is-better', // or 'higher-is-better'
  async measure() {
    return { value: 42, unit: 'things', breakdown: { 'file.ts': 42 } };
  },
};
```

Then `pnpm ratchet:record` to add it to the baseline.

[eslint-plugin-sonarjs]: https://github.com/SonarSource/eslint-plugin-sonarjs
[typescript-eslint]: https://typescript-eslint.io/
[type-coverage]: https://github.com/plantain-00/type-coverage
[oxc#4863]: https://github.com/oxc-project/oxc/discussions/4863
