/**
 * `MenuContext` must be a HAND-WRITTEN narrow contract, not a wide
 * `Omit<WorkbenchContext, …>` projection.
 *
 * Why a plain `Omit` is wrong: `Omit<WorkbenchContext, 'registry' |
 * 'senderPolicy' | 'trustedWindowSenderIds' | 'simulatorApis'>` still drags
 * EVERYTHING else — `adapter`, `preloadPath`, `bridge?`, `connections`,
 * `windows` (WindowService → BrowserWindow), `storageApi?`, `appData?`… —
 * onto the host-facing menu surface. Every internal refactor of those
 * services then becomes an unreviewed breaking change for a host menuBuilder,
 * the exact failure mode the hand-written `MiniappRuntime` eliminated for the
 * runtime contract.
 *
 * Real consumption surface:
 *  - the built-in menu (src/main/menu/index.ts): settings entry →
 *    `ctx.openSettings()` and `ctx.notify.windowNavigateBack()` (打开项目);
 *  - a host menuBuilder's legitimate reads: `appName`, the narrow workspace
 *    set (`hasActiveSession` / `getProjectPath` / `openProject` /
 *    `closeProject` / `getSession`), `notify.projectStatus`.
 *
 * Locked contract (this file is the spec): hand-written `MenuContext` with
 *  - `appName: string`
 *  - the narrow workspace set above
 *  - `openSettings: () => Promise<void>`
 *  - `notify.projectStatus` + `notify.windowNavigateBack`
 * and WITHOUT the internal plumbing (`adapter` / `preloadPath` / `bridge` /
 * `connections` / `windows` / `storageApi`). A full `WorkbenchContext` must
 * STAY assignable to `MenuContext` (structural subtyping — hosts that pass
 * the whole ctx through keep compiling).
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { MenuContext, WorkbenchAppConfig } from './types.js'
import type { WorkbenchContext } from '../main/services/workbench-context.js'

// ── type-level helpers ──────────────────────────────────────────────────────
type HasKey<T, K extends PropertyKey> = K extends keyof T ? true : false
type Not<B extends boolean> = B extends true ? false : true
type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false
function staticAssert<_T extends true>(): void {}

// ═════════════════════════════════════════════════════════════════════════
// §1 Members the narrow contract must KEEP (green pins — compile today via
// the Omit projection, and post-fix only if the hand-written shape carries
// them; this encodes the audited consumption surface).
// ═════════════════════════════════════════════════════════════════════════

function _menuConsumptionPin(menuCtx: MenuContext): void {
  const appName: string = menuCtx.appName

  // Narrow workspace set a menu legitimately drives.
  const active: boolean = menuCtx.workspace.hasActiveSession()
  const projectPath: string = menuCtx.workspace.getProjectPath()
  const opened: Promise<{ success: boolean; error?: string }> =
    menuCtx.workspace.openProject('/some/project')
  const closed: Promise<void> = menuCtx.workspace.closeProject()
  const session = menuCtx.workspace.getSession()

  // The built-in menu's two actions, on the narrow surface.
  menuCtx.notify.projectStatus({ status: 'ready', message: '编译完成' })
  menuCtx.notify.windowNavigateBack()
  const settings: Promise<void> = menuCtx.openSettings()

  void appName
  void active
  void projectPath
  void opened
  void closed
  void session
  void settings
}
void _menuConsumptionPin

// ═════════════════════════════════════════════════════════════════════════
// §2 Members the narrow contract must LOSE — these are reachable through an
// Omit projection. Bug guarded: re-widening silently re-promises internal
// plumbing — and Electron types (`windows` → WindowService → BrowserWindow) —
// to host menu builders.
// ═════════════════════════════════════════════════════════════════════════

staticAssert<Not<HasKey<MenuContext, 'adapter'>>>()
staticAssert<Not<HasKey<MenuContext, 'preloadPath'>>>()
staticAssert<Not<HasKey<MenuContext, 'bridge'>>>()
staticAssert<Not<HasKey<MenuContext, 'connections'>>>()
staticAssert<Not<HasKey<MenuContext, 'windows'>>>()
staticAssert<Not<HasKey<MenuContext, 'storageApi'>>>()

// ═════════════════════════════════════════════════════════════════════════
// §3 Guarantees shared with menu-builder-context-narrowed.test.ts — the
// internal pipeline must stay unreachable on the hand-written `MenuContext`.
// ═════════════════════════════════════════════════════════════════════════

// Internal pipeline stays unreachable.
staticAssert<Not<HasKey<MenuContext, 'registry'>>>()
staticAssert<Not<HasKey<MenuContext, 'senderPolicy'>>>()
staticAssert<Not<HasKey<MenuContext, 'trustedWindowSenderIds'>>>()
staticAssert<Not<HasKey<MenuContext, 'simulatorApis'>>>()

// The menuBuilder hook still takes exactly MenuContext as its 2nd parameter.
type MenuBuilderHook = NonNullable<WorkbenchAppConfig['menuBuilder']>
staticAssert<Equal<Parameters<MenuBuilderHook>[1], MenuContext>>()

// THE structural-subtyping sentinel: a full WorkbenchContext must remain
// assignable to MenuContext, so hosts that pass the whole ctx through
// (a downstream host's pattern) keep compiling across the narrowing.
const _contextSatisfiesMenuContext: (ctx: WorkbenchContext) => MenuContext = (ctx) => ctx
void _contextSatisfiesMenuContext

// ═════════════════════════════════════════════════════════════════════════
// §4 Runtime assertion: types.ts declares MenuContext as a hand-written
// interface, not an Omit projection.
// ═════════════════════════════════════════════════════════════════════════

const thisTestFile = import.meta.url.startsWith('file:')
  ? fileURLToPath(import.meta.url)
  : import.meta.url
const typesSourcePath = path.join(path.dirname(thisTestFile), 'types.ts')

describe('feedback ⑤ — MenuContext is hand-written, not an Omit<WorkbenchContext, …> projection', () => {
  it('types.ts does not declare MenuContext via Omit<…>', () => {
    // Real bug: the Omit projection puts every nested internal service type
    // on the host-facing menu surface — internal refactors become breaking
    // changes a host menuBuilder discovers on upgrade (same failure mode the
    // hand-written MiniappRuntime already fixed; see its source guard).
    const source = readFileSync(typesSourcePath, 'utf8')
    expect(
      /MenuContext\s*=\s*Omit</.test(source),
      'shared/types.ts must declare MenuContext as a hand-written narrow interface, not `type MenuContext = Omit<WorkbenchContext, …>`',
    ).toBe(false)
  })
})
