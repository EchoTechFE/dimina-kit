/**
 * Spec for the WorkbenchContext import RATCHET (eslint.config.js
 * `no-restricted-syntax`). The ratchet exists to forbid GROWTH of dependencies
 * on the WorkbenchContext grab-bag type from non-whitelisted modules. This file
 * pins every AST shape the rule must catch plus the exemption mechanism.
 *
 * Forms that must be flagged (none produce a plain ImportSpecifier, the naive
 * selector):
 *   - named (type) import + qualified access — `import { WorkbenchContext }`
 *     and `import * as Wb` + `Wb.WorkbenchContext` (value and type-only flavors);
 *   - type-query import — `type T = import('…').WorkbenchContext` → TSImportType
 *     (fields `source` Literal, `qualifier` Identifier);
 *   - named / type re-export — `export { WorkbenchContext } from '…'` →
 *     ExportSpecifier; the aliased form keys on `local.name`, not `exported.name`;
 *   - export-star — `export * from '…/workbench-context.js'` →
 *     ExportAllDeclaration, an equivalent whole-barrel leak;
 *   - dynamic import expression — `await import('…/workbench-context.js')` →
 *     ImportExpression (Literal `source`), distinct from TSImportType;
 *   - module augmentation — `declare module '…/workbench-context.js' {…}` →
 *     TSModuleDeclaration; for a string-named module `id` is a Literal so an
 *     `[id.value=…]` selector cannot misfire on `declare module SomeNs {}`.
 *
 * GREEN anti-pins (must NOT be flagged): `require('…')` in a .ts file is already
 * blocked by @typescript-eslint/no-require-imports; export-star / dynamic import
 * / `declare module 'electron'` augmentation of UNRELATED modules stays allowed
 * (selectors key on the module source, never the node kind wholesale).
 *
 * Exemption granularity: there is no per-file `no-restricted-syntax: "off"`
 * block. Each grandfathered violation LINE carries an inline
 * `// eslint-disable-next-line no-restricted-syntax -- grandfathered(workbench-context): shrink-only`,
 * so a NEW violation in an already-grandfathered file is still reported. Block
 * ⑦ inventories the directive itself: `<= CEILING` is the hard gate (a new
 * exemption anywhere under src/ fails CI), and the exact count + per-file
 * snapshot make any add/remove (even budget-neutral churn) a visible diff.
 *
 * JSDoc `@type {import('…').WorkbenchContext}` and triple-slash references are
 * deliberately NOT ratcheted: they live in comment trivia (no AST node for
 * no-restricted-syntax), have no compile effect in .ts sources, and pull in
 * declaration files rather than the symbol — a bespoke comment-scanning rule is
 * out of scope.
 *
 * Harness: ESLint's Node API (`new ESLint` + `lintText`) loading the package's
 * own flat config against a VIRTUAL file path — no temp files, no CLI. The
 * shared config is not type-aware, so lintText on a non-existent path parses
 * fine. It pulls in eslint-plugin-only-warn (every error → warning), so
 * assertions key on `ruleId`, never on severity.
 */
import { describe, it, expect, vi } from 'vitest'
import { ESLint } from 'eslint'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

// Loading the package's full ESLint flat config is an integration-test cold
// start and can exceed Vitest's 5s default under CI worker contention.
vi.setConfig({ testTimeout: 15_000 })

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
)

/** A production-file path that is neither whitelisted nor grandfathered. */
const PROBE_FILE = path.join(packageRoot, 'src/main/utils/probe.ts')
const eslint = new ESLint({
  cwd: packageRoot,
  overrideConfigFile: path.join(packageRoot, 'eslint.config.js'),
})

async function lintAt(
  filePath: string,
  code: string,
): Promise<ESLint.LintResult> {
  const results = await eslint.lintText(code, { filePath })
  const result = results[0]
  if (!result) throw new Error(`lintText returned no result for ${filePath}`)
  return result
}

async function lintProbe(code: string): Promise<ESLint.LintResult> {
  return lintAt(PROBE_FILE, code)
}

function ratchetMessages(result: ESLint.LintResult) {
  return result.messages.filter((m) => m.ruleId === 'no-restricted-syntax')
}

function ratchetMessagesOnLine(result: ESLint.LintResult, line: number) {
  return ratchetMessages(result).filter((m) => m.line === line)
}

/**
 * The exact inline exemption marker the ratchet uses. The `-- …` justification
 * suffix is contractual (greppable audit trail); eslint only consumes the
 * directive part before `--`.
 */
const GRANDFATHER_COMMENT =
  '// eslint-disable-next-line no-restricted-syntax -- grandfathered(workbench-context): shrink-only'

describe('③ WorkbenchContext import ratchet', () => {
  it('named type import is flagged (GREEN pin — existing coverage must not regress)', async () => {
    const result = await lintProbe(
      [
        "import type { WorkbenchContext } from '../services/workbench-context.js'",
        '',
        'export type Probe = WorkbenchContext',
        '',
      ].join('\n'),
    )

    expect(
      ratchetMessages(result),
      'the named-import form must stay flagged by no-restricted-syntax',
    ).not.toHaveLength(0)
  })

  it('namespace import + qualified access is flagged', async () => {
    // The selector only matches ImportSpecifier nodes, so
    // `import * as Wb` + `Wb.WorkbenchContext` grows a new full-context
    // dependency without tripping CI — the exact growth the ratchet exists to
    // forbid.
    const result = await lintProbe(
      [
        "import * as Wb from '../services/workbench-context.js'",
        '',
        'export type Probe = Wb.WorkbenchContext',
        '',
      ].join('\n'),
    )

    expect(
      ratchetMessages(result),
      'the namespace-import bypass must be reported by no-restricted-syntax',
    ).not.toHaveLength(0)
  })

  it('type-only namespace import is flagged too', async () => {
    // `import type * as` is the flavor a type-position consumer would write;
    // it must not be a second loophole once the value flavor is closed.
    const result = await lintProbe(
      [
        "import type * as Wb from '../services/workbench-context.js'",
        '',
        'export type Probe = Wb.WorkbenchContext',
        '',
      ].join('\n'),
    )

    expect(
      ratchetMessages(result),
      'the type-only namespace-import bypass must be reported by no-restricted-syntax',
    ).not.toHaveLength(0)
  })
})

describe('④ WorkbenchContext ratchet — round 2 bypasses', () => {
  it('type-query import (TSImportType) is flagged', async () => {
    // `import('…').WorkbenchContext` in type position is a TSImportType node —
    // no ImportDeclaration, no ImportSpecifier — so a naive ratchet never fires.
    // A real instance exists in the tree (src/shared/types.ts:132) and is
    // grandfathered, but a NON-exempt file writing the same thing must be
    // reported.
    const result = await lintProbe(
      [
        'export type Probe =',
        "  import('../services/workbench-context.js').WorkbenchContext",
        '',
      ].join('\n'),
    )

    expect(
      ratchetMessages(result),
      'the type-query import bypass must be reported by no-restricted-syntax',
    ).not.toHaveLength(0)
  })

  it('named re-export is flagged', async () => {
    // `export { WorkbenchContext } from '…'` produces an
    // ExportSpecifier, not an ImportSpecifier — a module can become a fresh
    // distribution point for the grab-bag without ever "importing" it.
    const plain = await lintProbe(
      [
        "export { WorkbenchContext } from '../services/workbench-context.js'",
        '',
      ].join('\n'),
    )
    expect(
      ratchetMessages(plain),
      'the named re-export bypass must be reported by no-restricted-syntax',
    ).not.toHaveLength(0)

    // Aliased flavor: the WorkbenchContext name lives on `local`, the alias
    // on `exported` — a fix keying on `exported.name` would miss this.
    const aliased = await lintProbe(
      [
        'export {',
        '  WorkbenchContext as ContextForFriends,',
        "} from '../services/workbench-context.js'",
        '',
      ].join('\n'),
    )
    expect(
      ratchetMessages(aliased),
      'the ALIASED named re-export must be reported too (match local.name, not exported.name)',
    ).not.toHaveLength(0)
  })

  it('type re-export is flagged', async () => {
    // Same ExportSpecifier shape with
    // exportKind: 'type' on the ExportNamedDeclaration — the flavor a
    // type-position consumer would actually write.
    const result = await lintProbe(
      [
        'export type {',
        '  WorkbenchContext,',
        "} from '../services/workbench-context.js'",
        '',
      ].join('\n'),
    )

    expect(
      ratchetMessages(result),
      'the type re-export bypass must be reported by no-restricted-syntax',
    ).not.toHaveLength(0)
  })

  it('export-star from workbench-context is flagged', async () => {
    // `export *` (ExportAllDeclaration) re-exports the
    // whole barrel — including WorkbenchContext — with no specifier node of
    // any kind. Equivalent leak, completely invisible to the ratchet.
    const result = await lintProbe(
      ["export * from '../services/workbench-context.js'", ''].join('\n'),
    )

    expect(
      ratchetMessages(result),
      'the export-star bypass must be reported by no-restricted-syntax',
    ).not.toHaveLength(0)
  })

  it('require() in a .ts file is blocked by @typescript-eslint/no-require-imports (GREEN pin)', async () => {
    // Not a gap: the shared config (tseslint recommended) already reports
    // `require(…)` inside .ts sources via @typescript-eslint/no-require-imports
    // (verified by lintText on the current config). Pinned so that coverage
    // cannot silently disappear in a future config shuffle.
    const result = await lintProbe(
      [
        "const m = require('../services/workbench-context.js')",
        'export default m',
        '',
      ].join('\n'),
    )

    expect(
      result.messages.filter(
        (m) => m.ruleId === '@typescript-eslint/no-require-imports',
      ),
      'require() in .ts must stay blocked by @typescript-eslint/no-require-imports',
    ).not.toHaveLength(0)
  })

  it('grandfathered file stays exempt (inline-comment flavor)', async () => {
    // There is no per-file `no-restricted-syntax: "off"` block; the
    // grandfathered line carries the inline grandfather comment and must stay
    // exempt (block ⑥ pins the per-line granularity).
    const result = await lintAt(
      path.join(packageRoot, 'src/main/services/views/view-manager.ts'),
      [
        GRANDFATHER_COMMENT,
        "import type { WorkbenchContext } from '../workbench-context.js'",
        '',
        'export type Probe = WorkbenchContext',
        '',
      ].join('\n'),
    )

    expect(
      ratchetMessages(result),
      'inline-grandfathered lines must not be flagged by the ratchet',
    ).toHaveLength(0)
  })

  it('export-star from OTHER modules is not flagged (GREEN pin — no over-broad selector)', async () => {
    // Closing the export-star bypass must key on the workbench-context module
    // source, not ban ExportAllDeclaration wholesale.
    const result = await lintProbe(
      ["export * from './paths.js'", ''].join('\n'),
    )

    expect(
      ratchetMessages(result),
      're-exporting unrelated modules must stay allowed',
    ).toHaveLength(0)
  })
})

describe('⑤ WorkbenchContext ratchet — round 3: dynamic import & augmentation', () => {
  it('dynamic import() expression is flagged', async () => {
    // A RUNTIME `import('…/workbench-context.js')` is an ImportExpression node —
    // not an ImportDeclaration, not a TSImportType (which is type-position only)
    // — so a module could otherwise lazily load the whole grab-bag at runtime
    // without tripping the ratchet at all.
    const result = await lintProbe(
      [
        'export async function loadFullContext() {',
        "  const m = await import('../services/workbench-context.js')",
        '  return m',
        '}',
        '',
      ].join('\n'),
    )

    expect(
      ratchetMessages(result),
      'the dynamic-import (ImportExpression) bypass must be reported by no-restricted-syntax',
    ).not.toHaveLength(0)
  })

  it('module augmentation of workbench-context is flagged', async () => {
    // `declare module '…/workbench-context.js' {…}` is a
    // TSModuleDeclaration — no import/export node of any kind — yet it is the
    // WORST growth direction: instead of merely depending on the grab-bag, a
    // module silently widens the grab-bag's own interface for everyone.
    const result = await lintProbe(
      [
        "declare module '../services/workbench-context.js' {",
        '  interface WorkbenchContext {',
        '    __probeExtraCapability: number',
        '  }',
        '}',
        'export {}',
        '',
      ].join('\n'),
    )

    expect(
      ratchetMessages(result),
      'the module-augmentation bypass must be reported by no-restricted-syntax',
    ).not.toHaveLength(0)
  })

  it('dynamic import / augmentation of OTHER modules stays allowed (GREEN anti-pin)', async () => {
    // Closing the two holes above must key on the module source — neither a
    // wholesale ImportExpression ban nor a wholesale TSModuleDeclaration ban.
    // `declare module 'electron'` augmentation is the canonical legitimate
    // case in this codebase, and lazy-loading unrelated modules is normal.
    const result = await lintProbe(
      [
        "declare module 'electron' {",
        '  interface App {',
        '    __probeFlag?: string',
        '  }',
        '}',
        '',
        'export async function loadPaths() {',
        "  return import('./paths.js')",
        '}',
        '',
      ].join('\n'),
    )

    expect(
      ratchetMessages(result),
      'dynamic import / module augmentation of unrelated modules must stay allowed',
    ).toHaveLength(0)
  })
})

describe('⑥ WorkbenchContext ratchet — round 3: exemption granularity goes inline', () => {
  // The per-file `no-restricted-syntax: "off"` block in eslint.config.js is
  // revoked; each grandfathered VIOLATION LINE instead carries
  // GRANDFATHER_COMMENT. Behavioral contract pinned here: exempt lines stay
  // exempt, but a grandfathered FILE is no longer a free-growth zone.

  const VIEW_MANAGER = 'src/main/services/views/view-manager.ts'
  const API_BARREL = 'src/main/api.ts'

  it('grandfathered file: inline-commented violation line stays exempt (GREEN pin)', async () => {
    // Mirrors the real violation (view-manager.ts:25) with the inline marker
    // the migration adds. Must be silent today (whole file off) AND after the
    // fix (inline disable) — continuity pin across the granularity change.
    const result = await lintAt(
      path.join(packageRoot, VIEW_MANAGER),
      [
        GRANDFATHER_COMMENT,
        "import { type WorkbenchContext } from '../workbench-context.js'",
        '',
        'export type Probe = WorkbenchContext',
        '',
      ].join('\n'),
    )

    expect(
      ratchetMessages(result),
      'the inline-grandfathered import line must not be reported',
    ).toHaveLength(0)
  })

  it('grandfathered file: a NEW uncommented violation must be reported', async () => {
    // Without per-line granularity, an already-grandfathered file could grow
    // ARBITRARY new WorkbenchContext dependencies invisibly — the exact growth
    // the ratchet exists to forbid.
    // Line 2 carries the grandfather marker (line 1) and stays exempt; the
    // namespace import on line 3 is new and unmarked, and MUST be reported.
    const result = await lintAt(
      path.join(packageRoot, VIEW_MANAGER),
      [
        GRANDFATHER_COMMENT, // line 1
        "import { type WorkbenchContext } from '../workbench-context.js'", // line 2
        "import * as WbFull from '../workbench-context.js'", // line 3 — NEW, unmarked
        '',
        'export type Probe = WorkbenchContext | WbFull.WorkbenchContext',
        '',
      ].join('\n'),
    )

    expect(
      ratchetMessagesOnLine(result, 3),
      'a new unmarked violation inside a grandfathered file must be reported',
    ).not.toHaveLength(0)
    expect(
      ratchetMessagesOnLine(result, 2),
      'the inline-grandfathered line must stay exempt even when the file has new violations',
    ).toHaveLength(0)
  })

  it('api.ts: inline-commented public re-export stays exempt (GREEN pin)', async () => {
    // api.ts is the package's public barrel — its WorkbenchContext re-export
    // (api.ts:25) is intended public surface, but the file moves from the
    // config whitelist to the same inline mechanism as everything else.
    const result = await lintAt(
      path.join(packageRoot, API_BARREL),
      [
        GRANDFATHER_COMMENT,
        "export type { WorkbenchContext, CreateContextOptions } from './services/workbench-context.js'",
        '',
      ].join('\n'),
    )

    expect(
      ratchetMessages(result),
      'the inline-exempted public re-export in api.ts must not be reported',
    ).toHaveLength(0)
  })

  it('api.ts: a NEW uncommented violation must be reported', async () => {
    // The barrel must not become a wholesale whitelist, or a future
    // edit could `export *` the entire workbench-context module through the
    // PUBLIC API without any signal. Line 2 is the marked existing re-export;
    // the export-star on line 3 is new and unmarked, and MUST be reported.
    const result = await lintAt(
      path.join(packageRoot, API_BARREL),
      [
        GRANDFATHER_COMMENT, // line 1
        "export type { WorkbenchContext, CreateContextOptions } from './services/workbench-context.js'", // line 2
        "export * from './services/workbench-context.js'", // line 3 — NEW, unmarked
        '',
      ].join('\n'),
    )

    expect(
      ratchetMessagesOnLine(result, 3),
      'a new unmarked violation in api.ts must be reported',
    ).not.toHaveLength(0)
    expect(
      ratchetMessagesOnLine(result, 2),
      'the inline-exempted re-export line must stay exempt even when api.ts has new violations',
    ).toHaveLength(0)
  })
})

describe('⑦ WorkbenchContext ratchet — round 4: grandfather inventory ceiling', () => {
  /**
   * The greppable audit token inside GRANDFATHER_COMMENT. Counted as an exact
   * substring so re-formatting the directive part (`eslint-disable-line` vs
   * `-next-line`, spacing) cannot dodge the inventory — what is ratcheted is
   * the JUSTIFICATION marker every exemption must carry.
   */
  const MARKER = 'grandfathered(workbench-context): shrink-only'

  /**
   * 缩短清单后请把上限同步下调 — when grandfathered lines are removed, lower
   * this ceiling (and the exact count + snapshot below) in the same change.
   * Shrinking without touching the ceiling still passes the hard gate (only
   * the exact-count/snapshot assertions below will ask for an update); ADDING
   * a 23rd directive necessarily fails here.
   */
  const CEILING = 22

  function listSourceFiles(dir: string): string[] {
    const out: string[] = []
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        out.push(...listSourceFiles(full))
      } else if (entry.isFile() && !/\.test\.tsx?$/.test(entry.name)) {
        out.push(full)
      }
    }
    return out
  }

  function countOccurrences(haystack: string, needle: string): number {
    return haystack.split(needle).length - 1
  }

  it('inline grandfather directives cannot grow: hard ceiling + exact distribution snapshot', () => {
    const srcRoot = path.join(packageRoot, 'src')
    const perFile = new Map<string, number>()
    for (const file of listSourceFiles(srcRoot)) {
      const n = countOccurrences(fs.readFileSync(file, 'utf8'), MARKER)
      if (n > 0) {
        perFile.set(path.relative(packageRoot, file).split(path.sep).join('/'), n)
      }
    }
    const total = [...perFile.values()].reduce((a, b) => a + b, 0)
    const distribution = [...perFile.entries()]
      .map(([file, n]) => `${file} ×${n}`)
      .sort()

    // ① HARD GATE — a 23rd inline exemption anywhere under src/ goes red.
    expect(
      total,
      `the shrink-only grandfather inventory must never grow past ${CEILING}; ` +
        'do NOT raise this ceiling — remove a WorkbenchContext dependency instead. ' +
        `current distribution:\n${distribution.join('\n')}`,
    ).toBeLessThanOrEqual(CEILING)

    // ② REVIEW VISIBILITY — any add/remove (including budget-neutral churn)
    // must show up as an explicit diff of the exact count + file snapshot.
    expect(
      total,
      'grandfather inventory changed — update the exact count, the snapshot ' +
        'below, AND (when shrinking) lower the ceiling in the same change',
    ).toBe(22)
    expect(distribution).toEqual([
      'src/main/api.ts ×1',
      'src/main/app/app.ts ×2',
      'src/main/ipc/app.ts ×1',
      'src/main/ipc/bridge-router.ts ×1',
      'src/main/ipc/popover.ts ×1',
      'src/main/ipc/project-fs.ts ×1',
      'src/main/ipc/projects.ts ×1',
      'src/main/ipc/session.ts ×1',
      'src/main/ipc/settings.ts ×1',
      'src/main/ipc/simulator.ts ×1',
      'src/main/ipc/views.ts ×1',
      'src/main/runtime/miniapp-runtime.ts ×1',
      'src/main/services/automation/exec.ts ×1',
      'src/main/services/automation/index.ts ×1',
      'src/main/services/automation/shared.ts ×1',
      'src/main/services/module.ts ×1',
      'src/main/services/views/view-manager.ts ×1',
      'src/main/services/workspace/workspace-service.ts ×1',
      'src/main/utils/sender-policy.ts ×1',
      'src/main/windows/main-window/events.ts ×1',
      'src/shared/types.ts ×1',
    ])
  })
})
