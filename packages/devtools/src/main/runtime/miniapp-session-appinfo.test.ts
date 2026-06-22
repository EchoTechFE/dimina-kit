/**
 * `getSession().appInfo` must be STRUCTURED, matching what
 * `docs/host-migration.md` already promises ("已结构化（appId/name/path），
 * 无需再 cast") but the types do not deliver:
 *
 *  - `MiniappRuntime['workspace']['getSession']` returns `{ appInfo: unknown }`
 *    — every downstream host is forced back into the exact cast the doc says
 *    is gone.
 *  - `ProjectSession['appInfo']` (src/shared/types.ts) is `AppInfo | unknown`,
 *    a union that ALWAYS collapses to `unknown` — the `AppInfo` arm is dead
 *    type-level decoration.
 *
 * `appId: string` is REQUIRED (not optional): the renderer genuinely depends
 * on `appId`; the devkit adapter always returns one (fallback included); a
 * session without it is unusable. The RUNTIME enforcement of the boundary
 * (openProject rejecting an appId-less adapter session) lives in
 * workspace/workspace-open-project-appinfo-validation.test.ts.
 *
 * Locked contract (this file is the spec):
 *  - A new exported type `MiniappSessionAppInfo` lives in
 *    `src/main/runtime/miniapp-runtime.ts` and is re-exported from the public
 *    barrel `src/main/api.ts` (package export "."). Field shapes follow what
 *    production actually puts on `session.appInfo`:
 *      · the default devkit adapter always provides `{ appId, name, path }`
 *        (packages/devkit/src/index.ts `AppInfo`), `appId` with a fallback —
 *        it is ALWAYS present ⇒ `appId: string` REQUIRED;
 *      · the devtools-side `AppInfo` mirror adds `appName?`;
 *      · a custom adapter may omit the decorative rest
 *    ⇒ `appId: string` required; `name?/path?/appName?: string` optional.
 *  - `getSession()`'s DTO types `appInfo` as `MiniappSessionAppInfo` (or
 *    `MiniappSessionAppInfo | null`; the pins below tolerate both), NOT
 *    `unknown`.
 *  - `ProjectSession['appInfo']`'s meaningless `AppInfo | unknown` union is
 *    fixed to a type that no longer collapses to `unknown`.
 *  - `asMiniappRuntime`'s identity-assignment sentinel must KEEP compiling,
 *    which forces `WorkspaceService.getSession` (the live implementation
 *    type) to be retyped in the same pass — no cast laundering.
 *
 * The `@ts-expect-error` markers below are compile-time guards: if a marked
 * line ever compiles, the directive becomes an unused-directive error (TS2578).
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { ProjectSession } from '../../shared/types.js'
import type { WorkbenchContext } from '../services/workbench-context.js'
import type { MiniappRuntime } from './miniapp-runtime.js'

// ── type-level helpers ──────────────────────────────────────────────────────
type Not<B extends boolean> = B extends true ? false : true
type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false
function staticAssert<_T extends true>(): void {}

type SessionDto = NonNullable<ReturnType<MiniappRuntime['workspace']['getSession']>>

// ═════════════════════════════════════════════════════════════════════════
// §1 The exported type must exist (module + public barrel).
// Real bug caught (post-flip): the structured type silently drops off the
// public surface and hosts are back to deep-importing internals or casting.
// ═════════════════════════════════════════════════════════════════════════

type AppInfoFromModule = import('./miniapp-runtime.js').MiniappSessionAppInfo
type AppInfoFromBarrel = import('../api.js').MiniappSessionAppInfo
const _moduleTypePin: AppInfoFromModule | undefined = undefined
const _barrelTypePin: AppInfoFromBarrel | undefined = undefined
void _moduleTypePin
void _barrelTypePin

// ═════════════════════════════════════════════════════════════════════════
// §2 `getSession().appInfo` is no longer `unknown`.
// Real bug caught (post-flip): someone re-widens the DTO back to `unknown`
// and every host cast comes back, contradicting host-migration.md.
// ═════════════════════════════════════════════════════════════════════════

staticAssert<Not<Equal<SessionDto['appInfo'], unknown>>>()

// ═════════════════════════════════════════════════════════════════════════
// §3 `ProjectSession['appInfo']` — the `AppInfo | unknown` union is
// meaningless (it collapses to `unknown`; the `AppInfo` arm guards nothing).
// Real bug caught (post-flip): the collapsed union sneaks back in, making
// the declared `AppInfo` shape pure documentation-theater again.
// ═════════════════════════════════════════════════════════════════════════

staticAssert<Not<Equal<ProjectSession['appInfo'], unknown>>>()

// ═════════════════════════════════════════════════════════════════════════
// §4 Host consumption pin — the doc's "无需再 cast" promise, written as code.
// Each marked line is the exact cast-free access a downstream host
// performs; today every one is a compile error on `unknown`.
// ═════════════════════════════════════════════════════════════════════════

function _appInfoCastFreeConsumptionPin(rt: MiniappRuntime): void {
  const session = rt.workspace.getSession()
  // Null-tolerant guard: works whether the fixed slot is
  // `MiniappSessionAppInfo` or `MiniappSessionAppInfo | null`.
  if (!session || session.appInfo === null || session.appInfo === undefined) return

  const appId: string | undefined = session.appInfo.appId
  const name: string | undefined = session.appInfo.name
  const projectDir: string | undefined = session.appInfo.path
  const appName: string | undefined = session.appInfo.appName

  void appId
  void name
  void projectDir
  void appName
}
void _appInfoCastFreeConsumptionPin

// ═════════════════════════════════════════════════════════════════════════
// §5 Field-shape pins — REVISED in the incremental round: `appId` REQUIRED,
// the rest optional. (Vacuously green today — `unknown` accepts anything —
// and REAL constraints the moment the slot is structured.)
// Real bug caught (post-flip):
//  - making name/path/appName REQUIRED would reject devkit's real shape and
//    minimal custom adapters (the `appIdOnly` pin);
//  - making appId OPTIONAL would silently re-legalize the appId-less session
//    the renderer cannot drive (the `_appIdIsRequiredPin` below).
// ═════════════════════════════════════════════════════════════════════════

function _appInfoShapeAcceptancePin(): void {
  // The default devkit adapter's concrete shape (no appName).
  const fromDevkit: SessionDto['appInfo'] = { appId: 'wx123', name: 'demo', path: '/proj' }
  // appId ALONE is sufficient — name/path/appName stay optional.
  const appIdOnly: SessionDto['appInfo'] = { appId: 'wx123' }
  void fromDevkit
  void appIdOnly
}
void _appInfoShapeAcceptancePin

function _appIdIsRequiredPin(info: AppInfoFromModule): string {
  // Compiles today (the suppressed import above resolves to an error-any);
  // post-flip this is the PERMANENT compile-time guard that `appId` is
  // required and non-optional — were it `appId?: string`, returning
  // `string | undefined` as `string` would not compile.
  return info.appId
}
void _appIdIsRequiredPin

// ═════════════════════════════════════════════════════════════════════════
// §6 The identity sentinel must KEEP compiling (green today and after).
// This is the pin that forces `WorkspaceService.getSession`'s return type to
// be restructured in the same pass — `asMiniappRuntime` is `return ctx`, so
// the live context must STRUCTURALLY satisfy the structured contract, not
// satisfy it through a cast.
// ═════════════════════════════════════════════════════════════════════════

const _contextStillSatisfiesContract: (ctx: WorkbenchContext) => MiniappRuntime = (ctx) => ctx
void _contextStillSatisfiesContract

// ═════════════════════════════════════════════════════════════════════════
// §7 Runtime assertions.
// ═════════════════════════════════════════════════════════════════════════

const thisTestFile = import.meta.url.startsWith('file:')
  ? fileURLToPath(import.meta.url)
  : import.meta.url
const contractSourcePath = path.join(path.dirname(thisTestFile), 'miniapp-runtime.ts')
const barrelSourcePath = path.join(path.dirname(thisTestFile), '..', 'api.ts')

describe('feedback ① — MiniappSessionAppInfo: structured session appInfo (doc/type矛盾闭合)', () => {
  it('miniapp-runtime.ts exports the MiniappSessionAppInfo type', () => {
    // Real bug: host-migration.md promises "appInfo 已结构化（appId/name/path），
    // 无需再 cast" while the contract module ships `{ appInfo: unknown }` — the
    // named, exported type is what makes the promise true.
    const source = readFileSync(contractSourcePath, 'utf8')
    expect(
      /export\s+(?:interface|type)\s+MiniappSessionAppInfo\b/.test(source),
      'miniapp-runtime.ts must export a MiniappSessionAppInfo interface/type — the structured session.appInfo shape host-migration.md already promises',
    ).toBe(true)
  })

  it('MiniappSessionAppInfo declares appId REQUIRED — `appId: string`, not `appId?:`', () => {
    // ⚠ Revised pin (see header): the first wave specified appId optional.
    // Real bug (post-flip): an optional appId re-opens the gap this item
    // closes — hosts are back to `if (!appInfo.appId)` defensive code for a
    // field production always supplies and the renderer always needs.
    const source = readFileSync(contractSourcePath, 'utf8')
    const decl = /export\s+(?:interface|type)\s+MiniappSessionAppInfo[^{]*\{([^}]*)\}/.exec(source)
    expect(decl, 'MiniappSessionAppInfo must exist (see the export pin above)').not.toBeNull()
    const body = decl![1]
    expect(
      /appId\s*:\s*string/.test(body),
      'MiniappSessionAppInfo must declare `appId: string`',
    ).toBe(true)
    expect(
      /appId\s*\?/.test(body),
      'appId must NOT be optional — required is the revised contract',
    ).toBe(false)
  })

  it('the public barrel (src/main/api.ts, package export ".") re-exports MiniappSessionAppInfo', () => {
    // Real bug: the type exists but is reachable only by deep-importing an
    // internal path — downstream hosts cannot name the DTO they receive.
    const source = readFileSync(barrelSourcePath, 'utf8')
    expect(
      /MiniappSessionAppInfo/.test(source),
      'src/main/api.ts must re-export MiniappSessionAppInfo next to MiniappRuntime',
    ).toBe(true)
  })

  it('getSession() DTO no longer types appInfo as bare unknown', () => {
    // Runtime mirror of the §2 sentinel: the contract module's source still
    // spelling the DTO `{ appInfo: unknown }` is the bug this item fixes.
    const source = readFileSync(contractSourcePath, 'utf8')
    expect(
      /\{\s*appInfo:\s*unknown\s*\}/.test(source),
      'the getSession DTO must type appInfo with MiniappSessionAppInfo (optionally | null), not `{ appInfo: unknown }`',
    ).toBe(false)
  })
})
