/**
 * `MiniappRuntime` is a HAND-WRITTEN public contract, not a
 * `Pick<WorkbenchContext, …>` projection.
 *
 * Why hand-written: `Pick` drags every nested internal service type
 * (ViewManager, BridgeRouterHandle, SimulatorApiRegistry, Electron
 * WebContents…) into the public semver face — any internal refactor of those
 * services becomes an unreviewed breaking change for downstream hosts.
 * The contract instead names ONLY the audited downstream-host consumption surface with
 * function-valued properties and structural DTOs; `asMiniappRuntime(ctx)`
 * stays an identity return and doubles as the assignment-compat sentinel:
 * internal drift breaks compilation HERE, not in a downstream host's upgrade.
 *
 * Type-level requirements cannot fail at vitest runtime, so (same as the other
 * type-guard tests, e.g. api-ipc-registry-export.test.ts) each
 * `@ts-expect-error` marker below is a permanent compile-time guard: if a
 * marked line ever compiles, the directive becomes an unused-directive error
 * (TS2578).
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { WorkbenchContext } from '../services/workbench-context.js'
import { asMiniappRuntime, type MiniappRuntime } from './miniapp-runtime.js'

// ── type-level helpers ──────────────────────────────────────────────────────
type HasKey<T, K extends PropertyKey> = K extends keyof T ? true : false
type Not<B extends boolean> = B extends true ? false : true
type KeyType<T, K extends PropertyKey> = K extends keyof T ? T[K] : never
// Runtime no-op; the type argument's `extends true` constraint is the assertion.
function staticAssert<_T extends true>(): void {}

// ═════════════════════════════════════════════════════════════════════════
// §1 Members the contract MUST GAIN (absent from a straight Pick projection).
// Real bug caught: a refactor drops the member from the contract
// and every downstream host using it breaks on upgrade instead of in our CI.
// ═════════════════════════════════════════════════════════════════════════

// DESIGNED CONTRACT CHANGE (feedback fix ② — see
// miniapp-runtime-open-settings.test.ts, which is the spec): `rendererDir`
// and `windows` are REMOVED from the contract. `windows` existed only for an
// `openSettingsWindow(ctx)` pass-through its own type could never satisfy
// (replaced by first-class `openSettings()`); `rendererDir`'s real need is
// served by the `/paths` export. The two HasKey pins below were flipped from
// positive to negative in that designed pass — re-adding either member is a
// deliberate semver decision, not an accident.
staticAssert<Not<HasKey<MiniappRuntime, 'rendererDir'>>>()
staticAssert<Not<HasKey<MiniappRuntime, 'windows'>>>()

// A downstream host registers its own teardown via `registry.add(dispose)`.
staticAssert<HasKey<MiniappRuntime, 'registry'>>()

// `registry.add` must accept a bare `() => void` dispose fn (a downstream host's call shape).
// Real constraint now that `registry` is on the contract — before it existed,
// `KeyType` resolved to `never`, which would have made this check vacuously true.
staticAssert<
  KeyType<KeyType<MiniappRuntime, 'registry'>, 'add'> extends (
    dispose: () => void,
  ) => unknown
    ? true
    : false
>()

// ═════════════════════════════════════════════════════════════════════════
// §2 Members the contract MUST LOSE (present via a straight Pick; a downstream host has ZERO
// uses — audited). Real bug caught: someone re-widens the
// contract, silently re-promising internal plumbing to hosts (先窄后宽 —
// adding back later is a deliberate minor bump, not an accident).
// ═════════════════════════════════════════════════════════════════════════

staticAssert<Not<HasKey<MiniappRuntime, 'bridge'>>>()
staticAssert<Not<HasKey<MiniappRuntime, 'simulatorApis'>>>()
staticAssert<Not<HasKey<MiniappRuntime, 'storageApi'>>>()
staticAssert<Not<HasKey<MiniappRuntime, 'appData'>>>()
staticAssert<Not<HasKey<MiniappRuntime, 'connections'>>>()

// ═════════════════════════════════════════════════════════════════════════
// §3 Narrowed sub-surfaces. The contract keeps the downstream-host-consumed members of
// each service and nothing else, so internal service refactors stay off the
// public semver face.
// ═════════════════════════════════════════════════════════════════════════

// `views` exposes ONLY `hostToolbar` — not the whole ViewManager.
staticAssert<Not<HasKey<MiniappRuntime['views'], 'getSimulatorWebContents'>>>()
// `getHostToolbarWebContentsId` was a workaround for reaching the toolbar's
// webContents; retired in favour of `send`/`onMessage`.
staticAssert<Not<HasKey<MiniappRuntime['views'], 'getHostToolbarWebContentsId'>>>()

// `views.hostToolbar` must NOT expose `webContents` (Electron type leak —
// downstream hosts migrated to the send/onMessage message channel).
staticAssert<Not<HasKey<MiniappRuntime['views']['hostToolbar'], 'webContents'>>>()

// (`windows` itself is gone from the contract — designed change, see §1 —
// so its old "opaque, no mainWindow re-exposure" pin is superseded by the
// stronger Not<HasKey<MiniappRuntime, 'windows'>> pin above.)

// `workspace` keeps only the 7 audited members; thumbnails are internal.
staticAssert<Not<HasKey<MiniappRuntime['workspace'], 'captureThumbnail'>>>()

// `getSession()` returns the minimal `{ appInfo } | null` DTO — `close` must
// NOT leak (hosts must end sessions via `closeProject`, never behind the
// workspace's back).
type SessionDto = NonNullable<ReturnType<MiniappRuntime['workspace']['getSession']>>
staticAssert<Not<HasKey<SessionDto, 'close'>>>()

// `notify` keeps only `projectStatus` (a downstream host's sole use).
staticAssert<Not<HasKey<MiniappRuntime['notify'], 'editorOpenFile'>>>()

// ═════════════════════════════════════════════════════════════════════════
// §4 Function-VALUED properties, not method syntax. Under strictFunctionTypes
// method signatures compare bivariantly, so a wrongly-narrowed implementation
// (or host override) slips past the sentinel. Real bug caught: a
// contract member written as `m(x: T): R` instead of `m: (x: T) => R` lets a
// narrower-param function typecheck as the member — the monkey-patch /
// drift-sentinel guarantees silently weaken.
// ═════════════════════════════════════════════════════════════════════════

type NarrowerParamOpenProject = (
  projectPath: '/the-only-allowed-path',
) => Promise<{ success: boolean; error?: string }>
type OpenProjectIsStrictlyVariant =
  NarrowerParamOpenProject extends MiniappRuntime['workspace']['openProject'] ? false : true
staticAssert<OpenProjectIsStrictlyVariant>()

type NarrowerParamProjectStatus = (payload: { status: 'ready'; message: string }) => void
type ProjectStatusIsStrictlyVariant =
  NarrowerParamProjectStatus extends MiniappRuntime['notify']['projectStatus'] ? false : true
staticAssert<ProjectStatusIsStrictlyVariant>()

// ═════════════════════════════════════════════════════════════════════════
// §5 Permanent compile pins (regression guards).
// ═════════════════════════════════════════════════════════════════════════

// THE assignment-compat sentinel: a real WorkbenchContext must always satisfy
// the contract via plain assignment (this is what makes `asMiniappRuntime`'s
// identity return compile). If an internal service drifts away from the
// contract, THIS stops compiling — in our package, not in a downstream host's upgrade.
const _contextSatisfiesContract: (ctx: WorkbenchContext) => MiniappRuntime = (ctx) => ctx
void _contextSatisfiesContract

/**
 * The audited downstream-host consumption surface, written as code. Never executed —
 * compile-only. Real bug caught: ANY signature change to a member a downstream host
 * actually calls (param/return DTO drift, a member going readonly, a member
 * disappearing) stops this function compiling.
 */
function _downstreamConsumptionPin(rt: MiniappRuntime): void {
  // workspace — the 7 audited members, exact call shapes a downstream host uses
  const active: boolean = rt.workspace.hasActiveSession()
  const projectPath: string = rt.workspace.getProjectPath()
  const opened: Promise<{ success: boolean; error?: string }> =
    rt.workspace.openProject('/downstream/project')
  const closed: Promise<void> = rt.workspace.closeProject()
  const has: Promise<boolean> = rt.workspace.hasProject('/downstream/project')
  rt.workspace.addProject('/downstream/project') // return value discarded by the host
  const session: { appInfo: unknown } | null = rt.workspace.getSession()

  // HARD CONSTRAINT — a downstream host monkey-patches openProject for permission gating;
  // the member must stay assignable (NOT readonly) at the type level.
  rt.workspace.openProject = async (gatedPath: string) => ({
    success: false,
    error: `denied: ${gatedPath}`,
  })

  // views.hostToolbar — the host surface (no webContents anywhere)
  rt.views.hostToolbar.setPreloadPath('/downstream/toolbar-preload.cjs')
  rt.views.hostToolbar.setPreloadPath(null)
  const loadedFile: Promise<void> = rt.views.hostToolbar.loadFile('/downstream/toolbar.html')
  const loadedUrl: Promise<void> = rt.views.hostToolbar.loadURL('https://downstream.example/toolbar')
  const sent: boolean = rt.views.hostToolbar.send('downstream:state', { connected: true })
  const sub: { dispose: () => void } = rt.views.hostToolbar.onMessage(
    'downstream:action',
    (payload: unknown) => {
      void payload
    },
  )
  sub.dispose()
  rt.views.hostToolbar.setHeightMode('auto')
  rt.views.hostToolbar.setHeightMode({ fixed: 40 })

  // notify — status broadcast with a downstream host's structural payload
  rt.notify.projectStatus({ status: 'ready', message: '编译完成' })

  void active
  void projectPath
  void opened
  void closed
  void has
  void session
  void loadedFile
  void loadedUrl
  void sent
}
void _downstreamConsumptionPin

// ═════════════════════════════════════════════════════════════════════════
// §6 Runtime assertions.
// ═════════════════════════════════════════════════════════════════════════

// Under vitest's transform `import.meta.url` is not always a `file:` URL —
// resolve the sibling source file from either form.
const thisTestFile = import.meta.url.startsWith('file:')
  ? fileURLToPath(import.meta.url)
  : import.meta.url
const contractSourcePath = path.join(path.dirname(thisTestFile), 'miniapp-runtime.ts')

describe('MiniappRuntime contract — hand-written, Electron-free module', () => {
  it('is hand-written: MiniappRuntime is NOT declared via a Pick<…> projection', () => {
    // Real bug: `Pick<WorkbenchContext, …>` puts every nested internal service
    // type on the public semver face — internal refactors of ViewManager /
    // bridge / storage types become breaking changes a downstream host discovers on
    // upgrade. The hand-written interface decouples them.
    const source = readFileSync(contractSourcePath, 'utf8')
    expect(
      /=\s*Pick</.test(source),
      'miniapp-runtime.ts must declare the contract as a hand-written interface, not `type MiniappRuntime = Pick<WorkbenchContext, …>` — Pick couples the public contract to every nested internal service type',
    ).toBe(false)
  })

  it('never imports electron (no Electron types/values on the contract surface)', () => {
    // Real bug: someone "conveniently" types a member with WebContents /
    // BrowserWindow — every Electron major then leaks into the contract's
    // semver, and non-Electron consumers of the type can no longer compile.
    const source = readFileSync(contractSourcePath, 'utf8')
    expect(
      /from\s+['"]electron['"]|require\(\s*['"]electron['"]/.test(source),
      'the contract module must not import electron — members use structural DTOs only',
    ).toBe(false)
  })

  it('asMiniappRuntime is an identity return (typed view, not a projection object)', () => {
    // Real bug: returning a new object of copied members means a downstream
    // host's monkey-patch of workspace.openProject patches a dead copy and the
    // permission gate silently stops gating.
    const fake = { tag: 'fake-context' } as unknown as WorkbenchContext
    expect(asMiniappRuntime(fake)).toBe(fake)
  })
})
