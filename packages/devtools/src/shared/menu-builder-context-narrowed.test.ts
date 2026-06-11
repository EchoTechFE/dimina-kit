/**
 * Workbench model refactor — "收尾", Requirement B:
 * the `menuBuilder` config hook's `context` parameter is NARROWED.
 *
 * `docs/workbench-model.md` ("`menuBuilder` 签名收窄") + the
 * mapping table row: "menuBuilder … 保留；签名收窄为 menu-only context
 * (不交出 `registry` 等内部状态)".
 *
 *  B1. A new exported type `MenuContext` exists in `src/shared/types.ts`,
 *      defined as `WorkbenchContext` with the internal-plumbing fields
 *      removed:
 *        Omit<WorkbenchContext,
 *          'registry' | 'senderPolicy' | 'trustedWindowSenderIds'
 *          | 'simulatorApis' | 'toolbar'>
 *  B2. `WorkbenchAppConfig['menuBuilder']` is
 *        (mainWindow: BrowserWindow, menuContext: MenuContext) => void
 *      so a host menu builder can read `.workspace` / `.views` / `.windows`
 *      / `.notify` / `.appName` etc., but CANNOT reach the internal pipeline
 *      fields (`registry`, `senderPolicy`, `trustedWindowSenderIds`,
 *      `simulatorApis`, `toolbar`).
 *
 * ── How `tsc` enforces this contract ───────────────────────────────────────
 *
 * This is a COMPILE-TIME test. It carries no runtime assertions — the
 * `describe`/`it` body is empty; the contract lives entirely in the
 * `// @ts-expect-error` annotations and the type-level `Expect<…>` checks
 * below.
 *
 * `check-types` runs `tsc --noEmit` against `tsconfig.json`, which `include`s
 * all of `src/` and does NOT exclude `*.test.ts`. So `tsc` genuinely
 * type-checks this file. (`build:main` uses `tsconfig.main.json`, which
 * *does* exclude `*.test.ts`, so this file never reaches the shipped build.)
 *
 * `// @ts-expect-error` flips the polarity: it PASSES when the next line has
 * a type error and FAILS ("Unused '@ts-expect-error' directive") when the
 * line compiles cleanly. Each `// @ts-expect-error` here pins that the
 * guarded internal-pipeline field is unreachable on `MenuContext`; if the
 * field became reachable the directive would be unused and `tsc` would fail.
 *
 * Maintenance notes:
 *  - Do NOT "fix" this file by deleting `@ts-expect-error` directives.
 *    Each one encodes a required compile error; removing one removes a
 *    guarantee.
 *  - `MenuContext` must be `export`ed from `src/shared/types.ts` (this test
 *    imports it by name) and must be a strict `Omit` of `WorkbenchContext`
 *    over exactly the five internal fields — no more, no fewer.
 */
import { describe, it } from 'vitest'
import type { BrowserWindow } from 'electron'
import type { WorkbenchAppConfig } from './types.js'
// `MenuContext` is a named export from this same module. The import itself is
// part of the contract: it must resolve to a real type (B1).
import type { MenuContext } from './types.js'
import type { WorkbenchContext } from '../main/services/workbench-context.js'

// ── tiny type-level assertion kit (no deps; checked purely by tsc) ──────────

type Expect<T extends true> = T
type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false

// The narrowed parameter of the production hook, extracted structurally so
// the assertions track whatever `WorkbenchAppConfig` actually declares.
type MenuBuilderHook = NonNullable<WorkbenchAppConfig['menuBuilder']>
type MenuBuilderCtxParam = Parameters<MenuBuilderHook>[1]
type MenuBuilderWinParam = Parameters<MenuBuilderHook>[0]

// ── B1/B2 — `MenuContext` shape and the hook's parameter types ─────────────

// Pins that the hook's context parameter is exactly `MenuContext` (not the
// full `WorkbenchContext`).
type _CtxParamIsMenuContext = Expect<Equal<MenuBuilderCtxParam, MenuContext>>

// Pins that `MenuContext` equals `WorkbenchContext` minus the five
// internal-pipeline fields — exactly.
type _MenuContextIsNarrowedOmit = Expect<
  Equal<
    MenuContext,
    Omit<
      WorkbenchContext,
      'registry' | 'senderPolicy' | 'trustedWindowSenderIds' | 'simulatorApis' | 'toolbar'
    >
  >
>

// The first parameter stays a `BrowserWindow` — narrowing must not touch it.
type _WinParamUnchanged = Expect<Equal<MenuBuilderWinParam, BrowserWindow>>

// ── B2 — value-level proof that the narrowing actually bites a host ────────

describe('Requirement B: menuBuilder context is narrowed to MenuContext', () => {
  it('forbids internal-pipeline fields and allows menu-relevant fields (compile-time only)', () => {
    // A host-supplied builder. Its `menuContext` parameter must be the
    // narrowed `MenuContext`.
    const _menuBuilder: MenuBuilderHook = (_mainWindow, menuContext) => {
      // ✅ Allowed: menu-relevant context fields stay reachable. None of the
      //    following lines may error — if one does, the narrowing removed a
      //    field the menu builder legitimately needs.
      void menuContext.appName
      void menuContext.workspace
      void menuContext.views
      void menuContext.windows
      void menuContext.notify
      void menuContext.projectsProvider

      // ❌ Forbidden: the five internal-pipeline fields must be unreachable.
      //    Each `@ts-expect-error` requires the next line to be a type error,
      //    pinning that the field is absent from `MenuContext`.

      // @ts-expect-error — `registry` is internal pipeline, not on MenuContext
      void menuContext.registry
      // @ts-expect-error — `senderPolicy` is internal pipeline, not on MenuContext
      void menuContext.senderPolicy
      // @ts-expect-error — `trustedWindowSenderIds` is internal, not on MenuContext
      void menuContext.trustedWindowSenderIds
      // @ts-expect-error — `simulatorApis` is internal pipeline, not on MenuContext
      void menuContext.simulatorApis
      // @ts-expect-error — `toolbar` is internal pipeline, not on MenuContext
      void menuContext.toolbar
    }
    void _menuBuilder
  })
})

// Reference the type-level checks so `noUnusedLocals` (if ever enabled) and
// readers both see they are intentional anchors, not dead code.
export type __MenuContextContract = [
  _CtxParamIsMenuContext,
  _MenuContextIsNarrowedOmit,
  _WinParamUnchanged,
]
