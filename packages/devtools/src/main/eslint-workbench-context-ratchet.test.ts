/**
 * ── ROUND 2 (codex re-review, 2026-06) ──────────────────────────────────────
 * The namespace bypass below was closed, but codex found the ratchet still
 * has bypass forms that never produce an ImportDeclaration at all. This file
 * gained a second describe block, `④ WorkbenchContext ratchet — round 2
 * bypasses`, pinning them:
 *
 *  RED today (verified: lintText returns ZERO `no-restricted-syntax`
 *  messages for each on the current config):
 *   1. type-query import:  type T = import('…/workbench-context.js').WorkbenchContext
 *      → `TSImportType` node (NOT an ImportDeclaration). NOTE for the fix:
 *      on this typescript-estree version the node's fields are
 *      `source` (Literal, the module string — older versions called it
 *      `argument`) and `qualifier` (Identifier `WorkbenchContext`).
 *   2. named re-export:    export { WorkbenchContext } from '…'
 *      → `ExportNamedDeclaration` > `ExportSpecifier`. For the aliased form
 *      (`export { WorkbenchContext as Ctx } from`), `local.name` is
 *      'WorkbenchContext' and `exported.name` is the alias — a selector must
 *      key on `local.name`.
 *   3. type re-export:     export type { WorkbenchContext } from '…'
 *      → same shape, `exportKind: 'type'` on the ExportNamedDeclaration.
 *   4. export-star:        export * from '…/workbench-context.js'
 *      → `ExportAllDeclaration` with `source.value` — re-exports the whole
 *      barrel, equivalent leak.
 *
 *  GREEN pins (must stay green through the fix):
 *   5. require('…/workbench-context.js') in a .ts file is ALREADY blocked by
 *      `@typescript-eslint/no-require-imports` (verified via lintText); pinned
 *      on that ruleId so the coverage can't silently vanish.
 *   - a grandfathered file (src/main/services/views/view-manager.ts, from the
 *     enumerated exception list in eslint.config.js) stays exempt;
 *   - export-star pointing at OTHER modules (`export * from './paths.js'`)
 *     must NOT be flagged (no over-broad ExportAllDeclaration selector).
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Codex review MAJOR ③ — the WorkbenchContext import RATCHET has a namespace
 * bypass.
 *
 * Today's gap, verified against eslint.config.js:117: the ratchet rule is a
 * single selector, `ImportSpecifier[imported.name='WorkbenchContext']` — it
 * only matches NAMED (specifier) imports. A module can reach the full
 * grab-bag type unflagged via a namespace import:
 *
 *   import * as Wb from '../services/workbench-context.js'
 *   type Deps = Wb.WorkbenchContext   // ratchet silently bypassed
 *
 * Locked contract (this file is the spec): for a NON-whitelisted production
 * file (virtual probe `src/main/utils/probe.ts`), `no-restricted-syntax`
 * must report BOTH
 *  - the named (type) import form — already caught, pinned GREEN so a fix
 *    cannot regress the existing coverage; and
 *  - the namespace import + qualified access form — RED today.
 *
 * Harness: ESLint's Node API (`new ESLint` + `lintText`), loading the
 * package's own flat config (`overrideConfigFile`) against a VIRTUAL file
 * path — no temp files, no CLI subprocess. There was no prior lintText test
 * in the repo, so this file establishes the harness. Verified feasible: the
 * shared config is not type-aware (plain tseslint.configs.recommended), so
 * lintText on a non-existent path parses fine. NOTE: the shared config pulls
 * in eslint-plugin-only-warn, which downgrades every error to a warning —
 * assertions key on `ruleId`, never on severity.
 */
import { describe, it, expect } from 'vitest'
import { ESLint } from 'eslint'
import path from 'path'
import { fileURLToPath } from 'url'

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
)

/** A production-file path that is neither whitelisted nor grandfathered. */
const PROBE_FILE = path.join(packageRoot, 'src/main/utils/probe.ts')

async function lintAt(
  filePath: string,
  code: string,
): Promise<ESLint.LintResult> {
  const eslint = new ESLint({
    cwd: packageRoot,
    overrideConfigFile: path.join(packageRoot, 'eslint.config.js'),
  })
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

  it('namespace import + qualified access is flagged [RED today: silent bypass]', async () => {
    // BUG CAUGHT (today): the selector only matches ImportSpecifier nodes, so
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

  it('type-only namespace import is flagged too [RED today: same bypass, type flavor]', async () => {
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

// ═══ ROUND 2 — new pins for this review cycle (see file header) ═════════════
describe('④ WorkbenchContext ratchet — round 2 bypasses', () => {
  it('type-query import (TSImportType) is flagged [RED today]', async () => {
    // BUG CAUGHT (today): `import('…').WorkbenchContext` in type position is
    // a TSImportType node — no ImportDeclaration, no ImportSpecifier — so the
    // ratchet never fires. codex found a real instance already in the tree
    // (src/shared/types.ts:132); that FILE will be grandfathered, but a
    // NON-exempt file writing the same thing must be reported.
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

  it('named re-export is flagged [RED today]', async () => {
    // BUG CAUGHT (today): `export { WorkbenchContext } from '…'` produces an
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

  it('type re-export is flagged [RED today]', async () => {
    // BUG CAUGHT (today): same ExportSpecifier shape with
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

  it('export-star from workbench-context is flagged [RED today]', async () => {
    // BUG CAUGHT (today): `export *` (ExportAllDeclaration) re-exports the
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

  it('grandfathered file stays exempt (GREEN pin — fix must not break the exception list)', async () => {
    // src/main/services/views/view-manager.ts is on the enumerated
    // grandfathered list in eslint.config.js; the ratchet (including any new
    // selectors added to close the round-2 bypasses) must stay OFF for it.
    const result = await lintAt(
      path.join(packageRoot, 'src/main/services/views/view-manager.ts'),
      [
        "import type { WorkbenchContext } from '../workbench-context.js'",
        '',
        'export type Probe = WorkbenchContext',
        '',
      ].join('\n'),
    )

    expect(
      ratchetMessages(result),
      'grandfathered files must not be flagged by the ratchet',
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
